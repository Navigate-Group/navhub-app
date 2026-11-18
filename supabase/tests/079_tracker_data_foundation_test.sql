-- Database tests for migration 079_tracker_data_foundation.sql (P1)
-- ──────────────────────────────────────────────────────────────────────────
-- A self-verifying, transaction-wrapped test script. It runs entirely inside
-- a single transaction that is ROLLED BACK at the end, so it leaves no trace
-- and is safe to run against any database that already has migration 079
-- applied (plus the base NavHub schema: groups, auth.users).
--
-- Run with:   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/079_tracker_data_foundation_test.sql
--         or: supabase db execute --file supabase/tests/079_tracker_data_foundation_test.sql
--
-- Any failed assertion RAISEs EXCEPTION, aborting with a non-zero exit code.
-- A clean run prints "ALL TRACKER P1 DATABASE TESTS PASSED".
--
-- Requires PostgreSQL 15+ (the actions→milestones FK uses the
-- ON DELETE SET NULL (column) form, available from PG15).

BEGIN;

SET LOCAL client_min_messages = WARNING;

DO $$
DECLARE
  -- Two groups to prove isolation; two synthetic users.
  g1 uuid := gen_random_uuid();
  g2 uuid := gen_random_uuid();
  u1 uuid := gen_random_uuid();
  u2 uuid := gen_random_uuid();
  p1 uuid;
  p2 uuid;
  m1 uuid;
  a1 uuid;
  cnt int;
  v_updated_on date;
  v_today date := (now() AT TIME ZONE 'Australia/Perth')::date;
  t text;
  tbls text[] := ARRAY[
    'tracker_project_plans','tracker_plan_members','tracker_plan_shares',
    'tracker_milestones','tracker_actions','tracker_updates',
    'tracker_contacts','tracker_contact_plans','tracker_comments',
    'tracker_reviews','tracker_activity_log','tracker_import_jobs',
    'tracker_settings','tracker_lookups'
  ];
  expected_count int := 14;
BEGIN
  -- ── 1. All 14 tables exist ────────────────────────────────────────────────
  SELECT count(*) INTO cnt
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = ANY(tbls);
  IF cnt <> expected_count THEN
    RAISE EXCEPTION 'Expected % tracker tables, found %', expected_count, cnt;
  END IF;

  -- ── 2. RLS enabled on all 14, with NO policies (P1) ───────────────────────
  SELECT count(*) INTO cnt
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = ANY(tbls) AND c.relrowsecurity;
  IF cnt <> expected_count THEN
    RAISE EXCEPTION 'Expected RLS enabled on % tables, found %', expected_count, cnt;
  END IF;

  SELECT count(*) INTO cnt FROM pg_policies
  WHERE schemaname = 'public' AND tablename = ANY(tbls);
  IF cnt <> 0 THEN
    RAISE EXCEPTION 'Expected 0 tracker policies in P1, found %', cnt;
  END IF;

  -- ── 3. Key columns / types spot-check ─────────────────────────────────────
  PERFORM 1 FROM information_schema.columns
    WHERE table_name = 'tracker_project_plans' AND column_name = 'updated_on'
      AND data_type = 'date' AND is_nullable = 'NO';
  IF NOT FOUND THEN RAISE EXCEPTION 'plans.updated_on missing/wrong type'; END IF;

  PERFORM 1 FROM information_schema.columns
    WHERE table_name = 'tracker_milestones' AND column_name = 'depends_on_ids'
      AND data_type = 'ARRAY';
  IF NOT FOUND THEN RAISE EXCEPTION 'milestones.depends_on_ids missing/wrong type'; END IF;

  -- enum types exist
  PERFORM 1 FROM pg_type WHERE typname = 'tracker_priority';
  IF NOT FOUND THEN RAISE EXCEPTION 'enum tracker_priority missing'; END IF;
  PERFORM 1 FROM pg_type WHERE typname = 'tracker_share_level';
  IF NOT FOUND THEN RAISE EXCEPTION 'enum tracker_share_level missing'; END IF;

  -- ── 4. Indexes present ────────────────────────────────────────────────────
  FOREACH t IN ARRAY ARRAY[
      'idx_tracker_project_plans_group',
      'idx_tracker_milestones_plan_group',
      'idx_tracker_actions_milestone_group',
      'idx_tracker_actions_assignee',
      'idx_tracker_actions_status_due',
      'idx_tracker_comments_entity',
      'idx_tracker_reviews_user_week'
  ] LOOP
    PERFORM 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = t;
    IF NOT FOUND THEN RAISE EXCEPTION 'Expected index % not found', t; END IF;
  END LOOP;

  -- ── Seed prerequisites (groups + users) ───────────────────────────────────
  INSERT INTO groups (id, name, slug) VALUES
    (g1, 'Test Group 1', 'tracker-test-g1-' || substr(g1::text,1,8)),
    (g2, 'Test Group 2', 'tracker-test-g2-' || substr(g2::text,1,8));
  INSERT INTO auth.users (id, email) VALUES
    (u1, 'tracker-test-u1-' || substr(u1::text,1,8) || '@example.com'),
    (u2, 'tracker-test-u2-' || substr(u2::text,1,8) || '@example.com');

  -- ── 5. tracker_init_group: idempotent, seeds settings + lookups ───────────
  PERFORM tracker_init_group(g1);
  PERFORM tracker_init_group(g1);  -- second call must not duplicate

  SELECT count(*) INTO cnt FROM tracker_settings WHERE group_id = g1;
  IF cnt <> 1 THEN RAISE EXCEPTION 'Expected 1 settings row, got %', cnt; END IF;

  PERFORM 1 FROM tracker_settings
    WHERE group_id = g1 AND chaser_days = 5 AND stale_days = 21
      AND contact_followup_days = 21 AND review_day = 'friday'
      AND week_start = 'monday' AND time_zone = 'Australia/Perth';
  IF NOT FOUND THEN RAISE EXCEPTION 'settings defaults incorrect'; END IF;

  SELECT count(DISTINCT list) INTO cnt FROM tracker_lookups WHERE group_id = g1;
  IF cnt <> 7 THEN RAISE EXCEPTION 'Expected 7 lookup lists seeded, got %', cnt; END IF;

  -- ── 6. Plan insert + owner required / stamp defaults ──────────────────────
  INSERT INTO tracker_project_plans (group_id, name, owner_id)
    VALUES (g1, 'Plan One', u1) RETURNING id, updated_on INTO p1, v_updated_on;
  IF v_updated_on <> v_today THEN
    RAISE EXCEPTION 'plan updated_on default not today (got %, want %)', v_updated_on, v_today;
  END IF;

  INSERT INTO tracker_project_plans (group_id, name, owner_id)
    VALUES (g2, 'Plan Two', u2) RETURNING id INTO p2;

  -- ── 7. Parent/child constraints ───────────────────────────────────────────
  -- self-parent rejected
  BEGIN
    UPDATE tracker_project_plans SET parent_id = p1 WHERE id = p1;
    RAISE EXCEPTION 'self-parent should have been rejected';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- cross-group parent rejected (p2 is in g2, p1 in g1)
  BEGIN
    UPDATE tracker_project_plans SET parent_id = p2 WHERE id = p1;
    RAISE EXCEPTION 'cross-group parent should have been rejected';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- ── 8. legacy_id uniqueness per group, but allowed across groups ──────────
  UPDATE tracker_project_plans SET legacy_id = 'L1' WHERE id = p1;
  UPDATE tracker_project_plans SET legacy_id = 'L1' WHERE id = p2;  -- other group: OK
  BEGIN
    INSERT INTO tracker_project_plans (group_id, name, owner_id, legacy_id)
      VALUES (g1, 'Dup legacy', u1, 'L1');
    RAISE EXCEPTION 'duplicate legacy_id within group should have been rejected';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- ── 9. Milestone + action cross-group FK guard ────────────────────────────
  INSERT INTO tracker_milestones (group_id, plan_id, title)
    VALUES (g1, p1, 'Milestone One') RETURNING id INTO m1;

  -- milestone on a plan in a different group must fail (composite FK)
  BEGIN
    INSERT INTO tracker_milestones (group_id, plan_id, title)
      VALUES (g2, p1, 'Bad group milestone');
    RAISE EXCEPTION 'cross-group milestone should have been rejected';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  INSERT INTO tracker_actions (group_id, plan_id, milestone_id, title)
    VALUES (g1, p1, m1, 'Action One') RETURNING id INTO a1;
  PERFORM 1 FROM tracker_actions WHERE id = a1 AND created_on = v_today;
  IF NOT FOUND THEN RAISE EXCEPTION 'action created_on default not today'; END IF;

  -- deleting the milestone NULLs the action's milestone_id (not group_id)
  DELETE FROM tracker_milestones WHERE id = m1;
  PERFORM 1 FROM tracker_actions WHERE id = a1 AND milestone_id IS NULL AND group_id = g1;
  IF NOT FOUND THEN RAISE EXCEPTION 'action milestone_id not SET NULL on milestone delete'; END IF;

  -- ── 10. Activity log trigger fires (created/updated/deleted) ──────────────
  SELECT count(*) INTO cnt FROM tracker_activity_log
    WHERE entity_type = 'tracker_project_plans' AND entity_id = p1 AND verb = 'created';
  IF cnt < 1 THEN RAISE EXCEPTION 'activity log: plan create not logged'; END IF;

  -- plan_id denormalised on the plan's own log row
  PERFORM 1 FROM tracker_activity_log
    WHERE entity_type = 'tracker_project_plans' AND entity_id = p1 AND plan_id = p1;
  IF NOT FOUND THEN RAISE EXCEPTION 'activity log: plan_id not denormalised for plan'; END IF;

  -- ── 11. Last-updated: real edit re-stamps updated_on to today ─────────────
  UPDATE tracker_project_plans SET updated_on = v_today - 10 WHERE id = p1;  -- pretend older
  -- preserve flag should stop re-stamp
  PERFORM set_config('app.tracker_preserve_updated_on', 'on', true);
  UPDATE tracker_project_plans SET summary = 'preserved edit' WHERE id = p1;
  SELECT updated_on INTO v_updated_on FROM tracker_project_plans WHERE id = p1;
  IF v_updated_on <> v_today - 10 THEN
    RAISE EXCEPTION 'preserve flag failed: updated_on moved to %', v_updated_on;
  END IF;
  PERFORM set_config('app.tracker_preserve_updated_on', 'off', true);

  -- normal edit re-stamps to today
  UPDATE tracker_project_plans SET summary = 'normal edit' WHERE id = p1;
  SELECT updated_on INTO v_updated_on FROM tracker_project_plans WHERE id = p1;
  IF v_updated_on <> v_today THEN
    RAISE EXCEPTION 'normal edit did not re-stamp updated_on to today (got %)', v_updated_on;
  END IF;

  -- ── 12. Update moves plan forward only ────────────────────────────────────
  -- A later-dated update pulls updated_on forward.
  INSERT INTO tracker_updates (group_id, plan_id, text, date)
    VALUES (g1, p1, 'future note', v_today + 5);
  SELECT updated_on INTO v_updated_on FROM tracker_project_plans WHERE id = p1;
  IF v_updated_on <> v_today + 5 THEN
    RAISE EXCEPTION 'later update did not move updated_on forward (got %)', v_updated_on;
  END IF;

  -- An earlier-dated update does NOT pull it back.
  INSERT INTO tracker_updates (group_id, plan_id, text, date)
    VALUES (g1, p1, 'past note', v_today - 30);
  SELECT updated_on INTO v_updated_on FROM tracker_project_plans WHERE id = p1;
  IF v_updated_on <> v_today + 5 THEN
    RAISE EXCEPTION 'earlier update wrongly moved updated_on back (got %)', v_updated_on;
  END IF;

  -- ── 13. Group isolation: g2 has no g1 lookups ─────────────────────────────
  SELECT count(*) INTO cnt FROM tracker_lookups WHERE group_id = g2;
  IF cnt <> 0 THEN RAISE EXCEPTION 'g2 should have no lookups before init, got %', cnt; END IF;

  RAISE NOTICE 'ALL TRACKER P1 DATABASE TESTS PASSED';
END $$;

ROLLBACK;
