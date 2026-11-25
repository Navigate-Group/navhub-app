-- Tests for 083_tracker_views.sql. Runs in one transaction and rolls back.
-- Run as the database owner:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/083_tracker_views_test.sql
-- Same fixture and expected numbers as lib/tracker/domain.test.ts, so passing
-- both proves the views and the business-rules module agree (SRS AC-4).
-- Today is pinned to Thursday 19 Nov 2026. A clean run prints
-- "ALL TRACKER VIEW TESTS PASSED".

BEGIN;

DO $$
DECLARE
  g   uuid := '10000000-0000-0000-0000-000000000001';
  g2  uuid := '10000000-0000-0000-0000-000000000002';
  u1  uuid := '20000000-0000-0000-0000-000000000001';  -- manager, owns every plan
  u2  uuid := '20000000-0000-0000-0000-000000000002';  -- staff, leads P2
  u3  uuid := '20000000-0000-0000-0000-000000000003';  -- manager of another group
  p1  uuid := '30000000-0000-0000-0000-000000000001';
  p1a uuid := '30000000-0000-0000-0000-000000000002';
  p2  uuid := '30000000-0000-0000-0000-000000000003';
  p3  uuid := '30000000-0000-0000-0000-000000000004';
  p4  uuid := '30000000-0000-0000-0000-000000000005';
  p5  uuid := '30000000-0000-0000-0000-000000000006';
  got text;
  n   int;
BEGIN
  PERFORM set_config('app.tracker_today', '2026-11-19', true);

  INSERT INTO groups (id, name, slug) VALUES
    (g, 'Test group', 'tracker-test-' || g::text), (g2, 'Other group', 'tracker-test-' || g2::text);
  INSERT INTO auth.users (id) VALUES (u1), (u2), (u3);
  INSERT INTO user_groups (user_id, group_id, role) VALUES (u1, g, 'manager'), (u2, g, 'staff'), (u3, g2, 'manager');
  PERFORM tracker_init_group(g);

  INSERT INTO tracker_project_plans (id, group_id, name, owner_id, lead_id, parent_id, status, updated_on, archived_at) VALUES
    (p1,  g, 'P1',  u1, NULL, NULL, 'on_track',           '2026-11-18', NULL),
    (p1a, g, 'P1a', u1, NULL, p1,   'on_track',           '2026-11-10', NULL),
    (p2,  g, 'P2',  u1, u2,   NULL, 'at_risk',            '2026-10-01', NULL),
    (p3,  g, 'P3',  u1, NULL, NULL, 'needs_status_check', '2026-11-17', NULL),
    (p4,  g, 'P4',  u1, NULL, NULL, 'finished',           '2026-01-01', NULL),
    (p5,  g, 'P5',  u1, NULL, NULL, 'on_track',           '2026-11-19', '2026-11-01T00:00:00Z');
  -- Plan edits stamp updated_on with today; put the fixture dates back.
  PERFORM set_config('app.tracker_preserve_updated_on', 'on', true);
  UPDATE tracker_project_plans SET updated_on = v.d
  FROM (VALUES (p1, date '2026-11-18'), (p1a, date '2026-11-10'), (p2, date '2026-10-01'),
               (p3, date '2026-11-17'), (p4, date '2026-01-01')) v(id, d)
  WHERE tracker_project_plans.id = v.id;
  INSERT INTO tracker_updates (group_id, plan_id, date, text) VALUES (g, p2, '2026-10-20', 'Update');
  UPDATE tracker_project_plans SET updated_on = '2026-10-01' WHERE id = p2;  -- the update moved it forward
  PERFORM set_config('app.tracker_preserve_updated_on', 'off', true);

  INSERT INTO tracker_milestones (id, group_id, plan_id, title, status, due_on, baseline_due_on, progress_mode, progress_pct) VALUES
    ('40000000-0000-0000-0000-000000000001', g, p1, 'M1', 'in_progress', '2026-11-25', '2026-11-20', 'from_actions', 0),
    ('40000000-0000-0000-0000-000000000002', g, p1, 'M2', 'planned',     '2026-11-12', NULL,         'manual',       40),
    ('40000000-0000-0000-0000-000000000003', g, p2, 'M3', 'planned',     NULL,         NULL,         'from_actions', 0),
    ('40000000-0000-0000-0000-000000000004', g, p3, 'M4', 'completed',   '2026-11-01', NULL,         'from_actions', 0);
  -- Migration 085's insert trigger defaults baseline_due_on to due_on; M2 and M4
  -- have no baseline in the domain model (days_slipped is "-"), so put it back.
  UPDATE tracker_milestones SET baseline_due_on = NULL
  WHERE id IN ('40000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000004');

  INSERT INTO tracker_actions (id, group_id, plan_id, milestone_id, title, type, assignee_id, due_on, status, waiting_since, done_on, created_on, archived_at) VALUES
    ('50000000-0000-0000-0000-000000000001', g, p1a, NULL, 'A1',  'call',   u2, '2026-11-17', 'open',    NULL,         NULL,         '2026-11-01', NULL),
    ('50000000-0000-0000-0000-000000000002', g, p1,  NULL, 'A2',  'do',     u1, '2026-11-19', 'open',    NULL,         NULL,         '2026-11-01', NULL),
    ('50000000-0000-0000-0000-000000000003', g, p1,  NULL, 'A3',  'email',  u1, '2026-11-21', 'open',    NULL,         NULL,         '2026-11-01', NULL),
    ('50000000-0000-0000-0000-000000000004', g, p1,  NULL, 'A4',  'do',     u1, '2026-11-25', 'open',    NULL,         NULL,         '2026-11-01', NULL),
    ('50000000-0000-0000-0000-000000000005', g, p1,  NULL, 'A5',  'do',     u1, '2026-12-10', 'open',    NULL,         NULL,         '2026-11-01', NULL),
    ('50000000-0000-0000-0000-000000000006', g, p1,  NULL, 'A6',  'decide', u1, NULL,         'open',    NULL,         NULL,         '2026-11-01', NULL),
    ('50000000-0000-0000-0000-000000000007', g, p2,  NULL, 'A7',  'do',     u2, '2026-11-15', 'waiting', '2026-11-10', NULL,         '2026-11-01', NULL),
    ('50000000-0000-0000-0000-000000000008', g, p2,  NULL, 'A8',  'do',     u2, '2026-11-22', 'waiting', '2026-11-17', NULL,         '2026-11-01', NULL),
    ('50000000-0000-0000-0000-000000000009', g, p1,  '40000000-0000-0000-0000-000000000001', 'A9',  'do', u1, NULL, 'done', NULL, '2026-11-17', '2026-11-01', NULL),
    ('50000000-0000-0000-0000-000000000010', g, p1,  '40000000-0000-0000-0000-000000000001', 'A10', 'do', u1, NULL, 'done', NULL, '2026-11-10', '2026-11-01', NULL),
    ('50000000-0000-0000-0000-000000000011', g, p1,  '40000000-0000-0000-0000-000000000001', 'A11', 'do', u1, '2026-11-30', 'open', NULL, NULL, '2026-11-01', NULL),
    ('50000000-0000-0000-0000-000000000012', g, NULL, NULL, 'A12', 'call',  u2, NULL,         'open',    NULL,         NULL,         '2026-11-01', NULL),
    ('50000000-0000-0000-0000-000000000013', g, p5,  NULL, 'A13', 'do',     u1, '2026-11-01', 'open',    NULL,         NULL,         '2026-11-01', NULL),
    ('50000000-0000-0000-0000-000000000014', g, p1,  NULL, 'A14', 'do',     u1, '2026-11-18', 'open',    NULL,         NULL,         '2026-11-01', '2026-11-18T00:00:00Z');

  -- 1. Helpers
  IF tracker_today(g) <> date '2026-11-19' THEN RAISE EXCEPTION '1: tracker_today not pinned'; END IF;
  IF tracker_week_start(date '2026-11-19', 'monday') <> date '2026-11-16'
     OR tracker_week_start(date '2026-11-19', 'sunday') <> date '2026-11-15' THEN
    RAISE EXCEPTION '1: tracker_week_start wrong';
  END IF;

  -- 2. Plan attention (archived P5 left out)
  SELECT count(*) INTO n FROM tracker_v_plan_attention WHERE group_id = g;
  IF n <> 5 THEN RAISE EXCEPTION '2: expected 5 plans, got %', n; END IF;
  SELECT string_agg(format('%s:%s,%s,%s,%s,%s%s%s%s,%s', right(plan_id::text, 1), open_actions, sub_plans,
                    COALESCE(right(next_action_id::text, 2), '-'), last_updated,
                    flag_status::int, flag_no_open_action::int, flag_overdue_action::int, flag_stale::int, needs_attention::int),
                    ' | ' ORDER BY plan_id)
    INTO got FROM tracker_v_plan_attention WHERE group_id = g;
  IF got IS DISTINCT FROM
    '1:7,1,01,2026-11-18,0010,1 | 2:1,0,01,2026-11-10,0010,1 | 3:2,0,-,2026-10-20,1001,1 | 4:0,0,-,2026-11-17,1100,1 | 5:0,0,-,2026-01-01,0000,0' THEN
    RAISE EXCEPTION '2: plan attention wrong. Got: %', got;
  END IF;

  -- 3. Milestone progress
  SELECT string_agg(format('%s/%s,%s,%s,%s', done_actions, total_actions, progress_pct,
                    COALESCE(days_slipped::text, '-'), overdue::int), ' | ' ORDER BY milestone_id)
    INTO got FROM tracker_v_milestone_progress WHERE group_id = g;
  IF got IS DISTINCT FROM '2/3,67,5,0 | 0/0,40,-,1 | 0/0,0,-,0 | 0/0,0,-,0' THEN
    RAISE EXCEPTION '3: milestone progress wrong. Got: %', got;
  END IF;

  -- 4. My week tiles
  SELECT string_agg(format('%s:%s,%s,%s,%s,%s,%s', right(user_id::text, 1), overdue, due_this_week, waiting_on_others,
                    calls_and_emails, plans_needing_attention, closed_this_week), ' | ' ORDER BY user_id)
    INTO got FROM tracker_v_action_counts WHERE group_id = g;
  IF got IS DISTINCT FROM '1:0,2,0,1,4,1 | 2:1,0,2,2,1,0' THEN
    RAISE EXCEPTION '4: action counts wrong. Got: %', got;
  END IF;

  -- 5. Closed per week
  SELECT string_agg(format('%s:%s=%s', right(user_id::text, 1), iso_week, closed), ' | ' ORDER BY user_id, iso_week)
    INTO got FROM tracker_v_closed_per_week WHERE group_id = g;
  IF got IS DISTINCT FROM '1:2026-W46=1 | 1:2026-W47=1' THEN
    RAISE EXCEPTION '5: closed per week wrong. Got: %', got;
  END IF;

  -- 6. Health checks (ids shortened to their last digits)
  SELECT string_agg(format('%s:%s,%s,%s,%s,%s', right(user_id::text, 1),
                    (SELECT COALESCE(string_agg(right(x::text, 2), '+'), '') FROM unnest(no_next_action_ids) x),
                    (SELECT COALESCE(string_agg(right(x::text, 2), '+'), '') FROM unnest(waiting_too_long_ids) x),
                    (SELECT COALESCE(string_agg(right(x::text, 2), '+'), '') FROM unnest(needs_status_check_ids) x),
                    (SELECT COALESCE(string_agg(right(x::text, 2), '+'), '') FROM unnest(no_recent_update_ids) x),
                    (SELECT COALESCE(string_agg(right(x::text, 2), '+'), '') FROM unnest(no_due_date_ids) x)),
                    ' | ' ORDER BY user_id)
    INTO got FROM tracker_v_health_checks WHERE group_id = g;
  IF got IS DISTINCT FROM '1:04,,04,03,06 | 2:,07,,03,12' THEN
    RAISE EXCEPTION '6: health checks wrong. Got: %', got;
  END IF;

  -- 7. The views follow the access rules (security_invoker). Since 086 a
  -- Manager sees every plan and Staff only the plans they lead, are members of,
  -- or were given access to (u2 leads P2 only).
  PERFORM set_config('request.jwt.claim.sub', u1::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO n FROM tracker_v_plan_attention WHERE group_id = g;
  IF n <> 5 THEN RAISE EXCEPTION '7: a manager sees % plans, expected 5', n; END IF;
  PERFORM set_config('role', 'none', true);

  PERFORM set_config('request.jwt.claim.sub', u2::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO n FROM tracker_v_plan_attention WHERE group_id = g;
  IF n <> 1 THEN RAISE EXCEPTION '7: staff leading P2 sees % plans, expected 1', n; END IF;

  PERFORM set_config('request.jwt.claim.sub', u3::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT (SELECT count(*) FROM tracker_v_plan_attention) + (SELECT count(*) FROM tracker_v_milestone_progress)
       + (SELECT count(*) FROM tracker_v_action_counts) + (SELECT count(*) FROM tracker_v_closed_per_week)
       + (SELECT count(*) FROM tracker_v_health_checks) INTO n;
  IF n <> 0 THEN RAISE EXCEPTION '7: someone outside the group sees % view rows', n; END IF;
  PERFORM set_config('role', 'none', true);

  RAISE WARNING 'ALL TRACKER VIEW TESTS PASSED';
END $$;

ROLLBACK;
