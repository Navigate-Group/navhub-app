-- Tests for 085_tracker_milestone_action_dates.sql. One transaction, rolled back.
-- Run as the database owner:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/085_tracker_milestone_action_dates_test.sql
-- Covers the action and milestone date triggers (done_on / waiting_since /
-- baseline_due_on / completed_on), that explicitly-passed dates are kept, and
-- the baseline guard (only the owner or a Manager / Group Owner may move it).
-- Today is pinned to Thursday 19 Nov 2026. A clean run prints
-- "ALL TRACKER DATE TESTS PASSED".
BEGIN;
DO $$
DECLARE
  g    uuid := '10000000-0000-0000-0000-000000000001';
  u1   uuid := '20000000-0000-0000-0000-000000000001';  -- manager (editor)
  u2   uuid := '20000000-0000-0000-0000-000000000002';  -- staff, the milestone owner
  u3   uuid := '20000000-0000-0000-0000-000000000003';  -- staff, no edit, not the owner
  p1   uuid := '30000000-0000-0000-0000-000000000001';
  mA   uuid := '40000000-0000-0000-0000-00000000000a';   -- baseline from due_on
  mB   uuid := '40000000-0000-0000-0000-00000000000b';   -- explicit baseline kept
  mC   uuid := '40000000-0000-0000-0000-00000000000c';   -- owned by u2, for the guard
  aX   uuid := '50000000-0000-0000-0000-00000000000a';
  d    date;
  s    text;
  ok   boolean;
BEGIN
  PERFORM set_config('app.tracker_today', '2026-11-19', true);

  INSERT INTO groups (id, name, slug) VALUES (g, 'Test group', 'tracker-test-' || g::text);
  INSERT INTO auth.users (id) VALUES (u1), (u2), (u3);
  INSERT INTO user_groups (user_id, group_id, role) VALUES
    (u1, g, 'manager'), (u2, g, 'staff'), (u3, g, 'staff');
  PERFORM tracker_init_group(g);
  INSERT INTO tracker_project_plans (id, group_id, name, owner_id, status)
    VALUES (p1, g, 'P1', u1, 'on_track');

  -- ── 1. Actions: done_on follows the status ────────────────────────────────
  INSERT INTO tracker_actions (id, group_id, plan_id, title, status)
    VALUES (aX, g, p1, 'AX', 'open');
  SELECT done_on, waiting_since INTO d, s FROM tracker_actions WHERE id = aX;
  IF d IS NOT NULL THEN RAISE EXCEPTION '1: open action should have no done_on'; END IF;

  UPDATE tracker_actions SET status = 'done' WHERE id = aX;
  SELECT done_on INTO d FROM tracker_actions WHERE id = aX;
  IF d <> date '2026-11-19' THEN RAISE EXCEPTION '1: done_on not set to today, got %', d; END IF;

  UPDATE tracker_actions SET status = 'open' WHERE id = aX;
  SELECT done_on INTO d FROM tracker_actions WHERE id = aX;
  IF d IS NOT NULL THEN RAISE EXCEPTION '1: leaving done did not clear done_on, got %', d; END IF;

  -- ── 2. Actions: waiting_since follows the status ──────────────────────────
  UPDATE tracker_actions SET status = 'waiting' WHERE id = aX;
  SELECT waiting_since INTO d FROM tracker_actions WHERE id = aX;
  IF d <> date '2026-11-19' THEN RAISE EXCEPTION '2: waiting_since not set to today, got %', d; END IF;

  UPDATE tracker_actions SET status = 'open' WHERE id = aX;
  SELECT waiting_since INTO d FROM tracker_actions WHERE id = aX;
  IF d IS NOT NULL THEN RAISE EXCEPTION '2: leaving waiting did not clear waiting_since, got %', d; END IF;

  -- ── 3. Actions: an explicitly-given date is kept ──────────────────────────
  UPDATE tracker_actions SET status = 'done', done_on = '2026-11-10' WHERE id = aX;
  SELECT done_on INTO d FROM tracker_actions WHERE id = aX;
  IF d <> date '2026-11-10' THEN RAISE EXCEPTION '3: explicit done_on not kept, got %', d; END IF;

  DELETE FROM tracker_actions WHERE id = aX;
  INSERT INTO tracker_actions (id, group_id, plan_id, title, status, waiting_since)
    VALUES (aX, g, p1, 'AX', 'waiting', '2026-11-05');
  SELECT waiting_since INTO d FROM tracker_actions WHERE id = aX;
  IF d <> date '2026-11-05' THEN RAISE EXCEPTION '3: explicit waiting_since not kept, got %', d; END IF;

  -- ── 4. Milestones: baseline_due_on defaults to due_on on insert ───────────
  INSERT INTO tracker_milestones (id, group_id, plan_id, title, status, due_on)
    VALUES (mA, g, p1, 'MA', 'planned', '2026-12-01');
  SELECT baseline_due_on INTO d FROM tracker_milestones WHERE id = mA;
  IF d <> date '2026-12-01' THEN RAISE EXCEPTION '4: baseline not taken from due_on, got %', d; END IF;

  -- ── 5. Milestones: an explicitly-given baseline is kept ───────────────────
  INSERT INTO tracker_milestones (id, group_id, plan_id, title, status, due_on, baseline_due_on)
    VALUES (mB, g, p1, 'MB', 'planned', '2026-12-10', '2026-11-30');
  SELECT baseline_due_on INTO d FROM tracker_milestones WHERE id = mB;
  IF d <> date '2026-11-30' THEN RAISE EXCEPTION '5: explicit baseline not kept, got %', d; END IF;

  -- Moving due_on later does not move the baseline.
  UPDATE tracker_milestones SET due_on = '2026-12-20' WHERE id = mB;
  SELECT baseline_due_on INTO d FROM tracker_milestones WHERE id = mB;
  IF d <> date '2026-11-30' THEN RAISE EXCEPTION '5: baseline changed when due_on moved, got %', d; END IF;

  -- ── 6. Milestones: completed_on follows the status ────────────────────────
  UPDATE tracker_milestones SET status = 'completed' WHERE id = mA;
  SELECT completed_on INTO d FROM tracker_milestones WHERE id = mA;
  IF d <> date '2026-11-19' THEN RAISE EXCEPTION '6: completed_on not set to today, got %', d; END IF;

  UPDATE tracker_milestones SET status = 'in_progress' WHERE id = mA;
  SELECT completed_on INTO d FROM tracker_milestones WHERE id = mA;
  IF d IS NOT NULL THEN RAISE EXCEPTION '6: leaving completed did not clear completed_on, got %', d; END IF;

  -- A milestone completed with an explicit date keeps it.
  UPDATE tracker_milestones SET status = 'completed', completed_on = '2026-11-15' WHERE id = mA;
  SELECT completed_on INTO d FROM tracker_milestones WHERE id = mA;
  IF d <> date '2026-11-15' THEN RAISE EXCEPTION '6: explicit completed_on not kept, got %', d; END IF;

  -- ── 7. Baseline guard: a Manager may change it ────────────────────────────
  INSERT INTO tracker_milestones (id, group_id, plan_id, title, owner_id, status, due_on)
    VALUES (mC, g, p1, 'MC', u2, 'planned', '2026-12-01');

  PERFORM set_config('request.jwt.claim.sub', u1::text, true);
  PERFORM set_config('role', 'authenticated', true);
  UPDATE tracker_milestones SET baseline_due_on = '2026-11-01' WHERE id = mC;
  PERFORM set_config('role', 'none', true);
  SELECT baseline_due_on INTO d FROM tracker_milestones WHERE id = mC;
  IF d <> date '2026-11-01' THEN RAISE EXCEPTION '7: manager could not move baseline, got %', d; END IF;

  -- ── 8. Baseline guard: the owner may change it ────────────────────────────
  PERFORM set_config('request.jwt.claim.sub', u2::text, true);
  PERFORM set_config('role', 'authenticated', true);
  UPDATE tracker_milestones SET baseline_due_on = '2026-11-02' WHERE id = mC;
  PERFORM set_config('role', 'none', true);
  SELECT baseline_due_on INTO d FROM tracker_milestones WHERE id = mC;
  IF d <> date '2026-11-02' THEN RAISE EXCEPTION '8: owner could not move baseline, got %', d; END IF;

  -- ── 9. Baseline guard: anyone else is refused ─────────────────────────────
  PERFORM set_config('request.jwt.claim.sub', u3::text, true);
  PERFORM set_config('role', 'authenticated', true);
  ok := true;
  BEGIN
    UPDATE tracker_milestones SET baseline_due_on = '2026-11-03' WHERE id = mC;
    ok := false;
  EXCEPTION WHEN insufficient_privilege THEN
    ok := true;
  END;
  PERFORM set_config('role', 'none', true);
  IF NOT ok THEN RAISE EXCEPTION '9: a non-owner without edit changed the baseline'; END IF;
  -- …but the same person may still move due_on.
  PERFORM set_config('request.jwt.claim.sub', u3::text, true);
  PERFORM set_config('role', 'authenticated', true);
  UPDATE tracker_milestones SET due_on = '2026-12-05' WHERE id = mC;
  PERFORM set_config('role', 'none', true);
  SELECT due_on INTO d FROM tracker_milestones WHERE id = mC;
  IF d <> date '2026-12-05' THEN RAISE EXCEPTION '9: a non-owner could not move due_on, got %', d; END IF;
  RAISE WARNING 'ALL TRACKER DATE TESTS PASSED';
END $$;
ROLLBACK;
