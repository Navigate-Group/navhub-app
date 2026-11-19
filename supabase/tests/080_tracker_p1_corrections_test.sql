-- Database tests for migration 080_tracker_p1_corrections.sql (P1 follow-up)
-- ──────────────────────────────────────────────────────────────────────────
-- A self-verifying, transaction-wrapped test script. It runs entirely inside a
-- single transaction that is ROLLED BACK at the end, so it leaves no trace and
-- is safe to run against any database that already has migrations 079 and 080
-- applied (plus the base NavHub schema: groups, auth.users).
--
-- Run with:   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/080_tracker_p1_corrections_test.sql
--         or: supabase db execute --file supabase/tests/080_tracker_p1_corrections_test.sql
--
-- Any failed assertion RAISEs EXCEPTION, aborting with a non-zero exit code.
-- A clean run prints "ALL TRACKER P1 CORRECTION TESTS PASSED".
--
-- Covers the five bugs fixed by migration 080:
--   1. action inserts succeed (stamp trigger no longer touches created_at);
--   2. deleting a parent plan clears the child's parent_id only (group_id kept);
--   3. deleting a user removes their plan_members / plan_shares / reviews rows;
--   4. deleting a group with tracker data succeeds (log trigger does not block);
--   5. tracker_init_group is SECURITY DEFINER with a fixed search_path and
--      still seeds settings + the seven lookup lists idempotently.
--
-- Requires PostgreSQL 15+ (the ON DELETE SET NULL (column) form).

BEGIN;

SET LOCAL client_min_messages = WARNING;

DO $$
DECLARE
  g1 uuid := gen_random_uuid();
  g2 uuid := gen_random_uuid();
  u1 uuid := gen_random_uuid();
  u2 uuid := gen_random_uuid();
  parent uuid;
  child  uuid;
  p1 uuid;
  a1 uuid;
  cnt int;
  v_group_id uuid;
  v_prosecdef boolean;
  v_search text;
BEGIN
  -- ── Seed prerequisites (groups + users) ───────────────────────────────────
  INSERT INTO groups (id, name, slug) VALUES
    (g1, 'Test Group 1', 'tracker-p1-g1-' || substr(g1::text,1,8)),
    (g2, 'Test Group 2', 'tracker-p1-g2-' || substr(g2::text,1,8));
  INSERT INTO auth.users (id, email) VALUES
    (u1, 'tracker-p1-u1-' || substr(u1::text,1,8) || '@example.com'),
    (u2, 'tracker-p1-u2-' || substr(u2::text,1,8) || '@example.com');

  PERFORM tracker_init_group(g1);

  -- ── Bug 5a. tracker_init_group is SECURITY DEFINER + fixed search_path ─────
  SELECT p.prosecdef, array_to_string(p.proconfig, ',')
    INTO v_prosecdef, v_search
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'tracker_init_group' AND n.nspname = 'public';
  IF v_prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'tracker_init_group is not SECURITY DEFINER';
  END IF;
  IF v_search IS NULL OR v_search NOT LIKE '%search_path=%' THEN
    RAISE EXCEPTION 'tracker_init_group has no fixed search_path (got %)', v_search;
  END IF;

  -- ── Bug 5b. Still seeds settings + seven lists, idempotently ──────────────
  PERFORM tracker_init_group(g1);  -- second call must not duplicate
  SELECT count(*) INTO cnt FROM tracker_settings WHERE group_id = g1;
  IF cnt <> 1 THEN RAISE EXCEPTION 'Expected 1 settings row, got %', cnt; END IF;
  SELECT count(DISTINCT list) INTO cnt FROM tracker_lookups WHERE group_id = g1;
  IF cnt <> 6 THEN RAISE EXCEPTION 'Expected 6 lookup lists seeded (region starts empty, 081), got %', cnt; END IF;

  -- ── Bug 1. Action inserts succeed (stamp trigger must not set created_at) ──
  INSERT INTO tracker_project_plans (group_id, name, owner_id)
    VALUES (g1, 'Plan One', u1) RETURNING id INTO p1;

  INSERT INTO tracker_actions (group_id, plan_id, title)
    VALUES (g1, p1, 'Action One') RETURNING id INTO a1;
  PERFORM 1 FROM tracker_actions
    WHERE id = a1 AND created_on = (now() AT TIME ZONE 'Australia/Perth')::date;
  IF NOT FOUND THEN RAISE EXCEPTION 'action insert failed or created_on default wrong'; END IF;

  -- updating an action still works (updated_at bumped, no created_at touched)
  UPDATE tracker_actions SET title = 'Action One (edited)' WHERE id = a1;
  PERFORM 1 FROM tracker_actions WHERE id = a1 AND title = 'Action One (edited)';
  IF NOT FOUND THEN RAISE EXCEPTION 'action update failed'; END IF;

  -- ── Bug 2. Parent delete clears child.parent_id ONLY (group_id preserved) ─
  INSERT INTO tracker_project_plans (group_id, name, owner_id)
    VALUES (g1, 'Parent Plan', u1) RETURNING id INTO parent;
  INSERT INTO tracker_project_plans (group_id, name, owner_id, parent_id)
    VALUES (g1, 'Child Plan', u1, parent) RETURNING id INTO child;

  DELETE FROM tracker_project_plans WHERE id = parent;

  SELECT group_id INTO v_group_id FROM tracker_project_plans WHERE id = child;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'child plan was wrongly deleted when parent was removed';
  END IF;
  IF v_group_id IS DISTINCT FROM g1 THEN
    RAISE EXCEPTION 'child plan group_id was blanked/changed on parent delete (got %)', v_group_id;
  END IF;
  PERFORM 1 FROM tracker_project_plans WHERE id = child AND parent_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'child plan parent_id not cleared on parent delete'; END IF;

  -- ── Bug 3. Deleting a user removes their members / shares / reviews ───────
  -- Use u2 as the deletable user (u1 owns plans with ON DELETE RESTRICT).
  INSERT INTO tracker_plan_members (plan_id, user_id, role)
    VALUES (p1, u2, 'member');
  INSERT INTO tracker_plan_shares (plan_id, user_id, level, shared_by)
    VALUES (p1, u2, 'view', u1);
  INSERT INTO tracker_reviews (group_id, user_id, iso_week)
    VALUES (g1, u2, '2024-W01');

  DELETE FROM auth.users WHERE id = u2;

  SELECT count(*) INTO cnt FROM tracker_plan_members WHERE user_id = u2;
  IF cnt <> 0 THEN RAISE EXCEPTION 'plan_members not cascaded on user delete (% left)', cnt; END IF;
  SELECT count(*) INTO cnt FROM tracker_plan_shares WHERE user_id = u2;
  IF cnt <> 0 THEN RAISE EXCEPTION 'plan_shares not cascaded on user delete (% left)', cnt; END IF;
  SELECT count(*) INTO cnt FROM tracker_reviews WHERE user_id = u2;
  IF cnt <> 0 THEN RAISE EXCEPTION 'reviews not cascaded on user delete (% left)', cnt; END IF;

  -- ── Bug 4. Deleting a group with tracker data succeeds ───────────────────
  -- g1 now has settings, lookups, a plan, an action, (members/shares/reviews
  -- for u2 were just removed). The group delete must cascade all tracker rows
  -- without the activity-log trigger blocking on its FK to groups.
  DELETE FROM groups WHERE id = g1;
  PERFORM 1 FROM groups WHERE id = g1;
  IF FOUND THEN RAISE EXCEPTION 'group g1 was not deleted'; END IF;

  SELECT count(*) INTO cnt FROM tracker_project_plans WHERE group_id = g1;
  IF cnt <> 0 THEN RAISE EXCEPTION 'tracker plans not cascaded on group delete (% left)', cnt; END IF;
  SELECT count(*) INTO cnt FROM tracker_activity_log WHERE group_id = g1;
  IF cnt <> 0 THEN RAISE EXCEPTION 'activity_log not cascaded on group delete (% left)', cnt; END IF;

  RAISE WARNING 'ALL TRACKER P1 CORRECTION TESTS PASSED';
END $$;

ROLLBACK;
