-- Tests for 081_tracker_starting_lists.sql. Runs in one transaction and rolls back.
-- Run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/081_tracker_starting_lists_test.sql
-- A clean run prints "ALL TRACKER STARTING LIST TESTS PASSED".
BEGIN;
DO $$
DECLARE
  g1 uuid := gen_random_uuid();
  cnt int;
  got text;
  want text;
BEGIN
  INSERT INTO groups (id, name, slug) VALUES (g1, 'Test group 1', 'tracker-test-' || g1::text);

  -- 1. Still SECURITY DEFINER with a fixed search_path.
  PERFORM 1 FROM pg_proc WHERE proname = 'tracker_init_group' AND prosecdef
    AND proconfig @> ARRAY['search_path=public, pg_temp'];
  IF NOT FOUND THEN RAISE EXCEPTION '1: tracker_init_group not security definer with fixed search_path'; END IF;

  -- 2. Seeds exactly the agreed lists, in order; region starts empty; idempotent.
  PERFORM tracker_init_group(g1);
  PERFORM tracker_init_group(g1);
  SELECT string_agg(list || ':' || keys, ' | ' ORDER BY list) INTO got FROM (
    SELECT list, string_agg(key, ',' ORDER BY sort_order) AS keys
    FROM tracker_lookups WHERE group_id = g1 GROUP BY list) s;
  want := 'action_type:do,call,email,chase,decide,meeting'
    || ' | category:product_software,data_science_ci,partners_field_trials,proposals_pipeline,grants'
    || ' | milestone_status:backlog,planned,in_progress,at_risk,blocked,completed,cancelled'
    || ' | review_step:clear_inbox,next_action_each_plan,chase_waiting,refresh_status,look_ahead,book_calls,pick_top_three'
    || ' | source:my_note,email,screenshot,meeting,file_folder,call'
    || ' | status:on_track,at_risk,blocked,waiting_on_others,proposal_pre_contract,wrapping_up,needs_status_check,finished';
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION '2: starting lists wrong. Got: %', got; END IF;

  -- 3. No duplicate sort_order within a list, and labels as agreed.
  SELECT count(*) INTO cnt FROM (
    SELECT list, sort_order FROM tracker_lookups WHERE group_id = g1
    GROUP BY list, sort_order HAVING count(*) > 1) d;
  IF cnt <> 0 THEN RAISE EXCEPTION '3: % duplicate sort_order values', cnt; END IF;
  PERFORM 1 FROM tracker_lookups WHERE group_id = g1
    AND list = 'status' AND key = 'needs_status_check' AND label = 'Needs a status check';
  IF NOT FOUND THEN RAISE EXCEPTION '3: status label wrong'; END IF;
  PERFORM 1 FROM tracker_lookups WHERE group_id = g1
    AND list = 'milestone_status' AND key = 'in_progress' AND label = 'In progress';
  IF NOT FOUND THEN RAISE EXCEPTION '3: milestone in_progress label wrong'; END IF;

  -- 4. One settings row; RLS still on for all 14 tables with no policies.
  SELECT count(*) INTO cnt FROM tracker_settings WHERE group_id = g1;
  IF cnt <> 1 THEN RAISE EXCEPTION '4: expected 1 settings row, got %', cnt; END IF;
  SELECT count(*) INTO cnt FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname LIKE 'tracker\_%' AND c.relkind = 'r' AND c.relrowsecurity;
  IF cnt <> 14 THEN RAISE EXCEPTION '4: RLS on % tracker tables, expected 14', cnt; END IF;
  SELECT count(*) INTO cnt FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'tracker\_%';
  IF cnt <> 0 THEN RAISE EXCEPTION '4: expected no tracker policies, found %', cnt; END IF;

  RAISE WARNING 'ALL TRACKER STARTING LIST TESTS PASSED';
END $$;
ROLLBACK;
