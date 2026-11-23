-- Tests for 084_tracker_import.sql. Runs in one transaction and rolls back.
-- Run as the database owner (e.g. postgres), after migrations 079–084:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/084_tracker_import_test.sql
-- Each check signs in as a test user (role authenticated + JWT sub claim), the
-- way Supabase runs requests. All data is made up.
-- A clean run prints "ALL TRACKER P4 IMPORT TESTS PASSED".
BEGIN;

-- ── Test helpers (created inside this transaction, rolled back at the end) ──
CREATE FUNCTION tracker_test_as(p_user uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'none', true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('request.jwt.claims',
    CASE WHEN p_user IS NULL THEN '' ELSE json_build_object('sub', p_user, 'role', 'authenticated')::text END, true);
  IF p_user IS NOT NULL THEN
    PERFORM set_config('role', 'authenticated', true);
  END IF;
END $$;

CREATE FUNCTION tracker_test_check(p_ok boolean, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAILED: %', p_label;
  END IF;
END $$;

-- The statement must fail with the given SQLSTATE.
CREATE FUNCTION tracker_test_refused(p_sql text, p_state text, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = p_state THEN RETURN; END IF;
    RAISE EXCEPTION 'FAILED: %: expected SQLSTATE %, got % (%)', p_label, p_state, SQLSTATE, SQLERRM;
  END;
  RAISE EXCEPTION 'FAILED: %: expected to be refused, but it was allowed', p_label;
END $$;

CREATE FUNCTION tracker_test_count(p_sql text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  EXECUTE p_sql INTO n;
  RETURN n;
END $$;

DO $$
DECLARE
  gA uuid := gen_random_uuid();
  gB uuid := gen_random_uuid();
  u_mgr   uuid := gen_random_uuid();  -- manager of gA (runs the import)
  u_own   uuid := gen_random_uuid();  -- group_owner of gA
  u_staff uuid := gen_random_uuid();  -- staff of gA
  u_out   uuid := gen_random_uuid();  -- manager of gB only
  tmpl    text;
  payload jsonb;
  s       jsonb;
  v_plans bigint;
  v_log   bigint;
  v_id    uuid;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_mgr, 'mgr@example.test'), (u_own, 'own@example.test'),
    (u_staff, 'staff@example.test'), (u_out, 'out@example.test');
  INSERT INTO groups (id, name, slug) VALUES (gA, 'Group A', 'group-a-p4'), (gB, 'Group B', 'group-b-p4');
  INSERT INTO user_groups (user_id, group_id, role, is_default) VALUES
    (u_mgr, gA, 'manager', true), (u_own, gA, 'group_owner', true),
    (u_staff, gA, 'staff', true), (u_out, gB, 'manager', true);

  -- A made-up file: the sub-project (X-2) comes before its parent (X-3);
  -- X-1's updates are dated after its "last updated".
  tmpl := $j${
    "regions": [{"key": "north", "label": "North"}],
    "plans": [
      {"legacy_id": "X-1", "name": "Alpha", "category": "data_science_ci", "status": "on_track",
       "client": "Client One", "phase": "Build", "summary": "Line one\nLine two", "folder": "",
       "region": null, "sort_order": 0, "owner_id": "$OWN", "parent_legacy_id": null, "updated_on": "2026-10-19"},
      {"legacy_id": "X-2", "name": "Alpha North", "category": "data_science_ci", "status": "waiting_on_others",
       "client": null, "phase": null, "summary": null, "folder": null,
       "region": "north", "sort_order": 1, "owner_id": null, "parent_legacy_id": "X-3", "updated_on": "2026-11-13"},
      {"legacy_id": "X-3", "name": "Beta", "category": "proposals_pipeline", "status": "proposal_pre_contract",
       "client": null, "phase": null, "summary": null, "folder": null,
       "region": null, "sort_order": 2, "owner_id": null, "parent_legacy_id": null, "updated_on": "2026-11-16"}
    ],
    "milestones": [
      {"plan_legacy_id": "X-1", "legacy_id": "first sample", "title": "First sample", "due_on": "2026-11-02", "status": "completed", "sort_order": 0},
      {"plan_legacy_id": "X-1", "legacy_id": "final report", "title": "Final report", "due_on": "2027-06-14", "status": "planned", "sort_order": 1}
    ],
    "contacts": [
      {"legacy_id": "C-1", "name": "Pat Example", "org": "Org One", "role": "Agronomist", "phone": null,
       "email": "pat@example.test", "notes": null, "last_contact": "2026-11-04", "plan_legacy_ids": ["X-1", "X-2"]},
      {"legacy_id": "C-2", "name": "Org Two", "org": "Org Two", "role": null, "phone": null,
       "email": null, "notes": "Add contact.", "last_contact": null, "plan_legacy_ids": ["X-3"]}
    ],
    "actions": [
      {"legacy_id": "A-1", "plan_legacy_id": "X-1", "title": "Write the report", "type": "do", "who": null,
       "contact_legacy_id": null, "assignee_id": "$STAFF", "due_on": null, "status": "open", "priority": "normal",
       "notes": null, "created_on": "2026-10-21", "waiting_since": null, "done_on": null},
      {"legacy_id": "A-2", "plan_legacy_id": "X-2", "title": "Get site locations", "type": "chase", "who": "Pat Example",
       "contact_legacy_id": "C-1", "assignee_id": null, "due_on": "2026-11-08", "status": "waiting", "priority": "high",
       "notes": "Asked twice", "created_on": "2026-10-19", "waiting_since": "2026-11-03", "done_on": null},
      {"legacy_id": "A-3", "plan_legacy_id": "X-3", "title": "Discovery meeting", "type": "meeting", "who": null,
       "contact_legacy_id": null, "assignee_id": null, "due_on": "2026-11-02", "status": "done", "priority": "normal",
       "notes": null, "created_on": "2026-10-27", "waiting_since": null, "done_on": "2026-11-04"}
    ],
    "updates": [
      {"legacy_id": "U-1", "plan_legacy_id": "X-1", "kind": "update", "date": "2026-11-04", "source": "call", "text": "Call notes"},
      {"legacy_id": "U-2", "plan_legacy_id": "X-1", "kind": "update", "date": "2026-10-07", "source": "file_folder", "text": "Saved the guide"},
      {"legacy_id": "handover:X-1", "plan_legacy_id": "X-1", "kind": "handover", "date": "2026-11-05", "source": null, "text": "## Where it stands\nOn track."}
    ],
    "reviews": [{"iso_week": "2026-W43", "checks": {"clear_inbox": false}}]
  }$j$;
  payload := replace(replace(tmpl, '$OWN', u_own::text), '$STAFF', u_staff::text)::jsonb;

  -- ── 1. Only Managers / Group Owners of the group can import ──
  PERFORM tracker_test_as(u_mgr);
  PERFORM tracker_init_group(gA);
  PERFORM tracker_test_as(u_staff);
  PERFORM tracker_test_refused(format('SELECT tracker_import_apply(%L, %L, %L)', gA, 'f.json', payload),
                               '42501', 'staff import');
  PERFORM tracker_test_as(u_out);
  PERFORM tracker_test_refused(format('SELECT tracker_import_apply(%L, %L, %L)', gA, 'f.json', payload),
                               '42501', 'manager of another group');
  PERFORM tracker_test_as(NULL);
  PERFORM tracker_test_check((SELECT count(*) FROM tracker_project_plans WHERE group_id = gA) = 0,
                             'refused imports saved nothing');

  -- ── 2. First import ──
  PERFORM tracker_test_as(u_mgr);
  s := tracker_import_apply(gA, 'f.json', payload);
  PERFORM tracker_test_check(s->'plans' = '{"new": 3, "changed": 0, "unchanged": 0}', 'plans summary: ' || s::text);
  PERFORM tracker_test_check(s->'milestones' = '{"new": 2, "changed": 0, "unchanged": 0}', 'milestones summary');
  PERFORM tracker_test_check(s->'contacts' = '{"new": 2, "changed": 0, "unchanged": 0}', 'contacts summary');
  PERFORM tracker_test_check(s->'contact_links' = '{"new": 3}', 'contact links summary');
  PERFORM tracker_test_check(s->'actions' = '{"new": 3, "changed": 0, "unchanged": 0}', 'actions summary');
  PERFORM tracker_test_check(s->'updates' = '{"new": 3, "changed": 0, "unchanged": 0}', 'updates summary');
  PERFORM tracker_test_check(s->'reviews' = '{"saved": 1}', 'reviews summary');

  PERFORM tracker_test_as(NULL);
  -- owners: given, else the importer
  PERFORM tracker_test_check((SELECT owner_id FROM tracker_project_plans WHERE group_id = gA AND legacy_id = 'X-1') = u_own, 'owner as given');
  PERFORM tracker_test_check((SELECT owner_id FROM tracker_project_plans WHERE group_id = gA AND legacy_id = 'X-3') = u_mgr, 'owner defaults to importer');
  -- sub-project linked although listed before its parent
  PERFORM tracker_test_check((SELECT c.parent_id = p.id FROM tracker_project_plans c, tracker_project_plans p
                              WHERE c.legacy_id = 'X-2' AND p.legacy_id = 'X-3' AND c.group_id = gA AND p.group_id = gA),
                             'sub-project linked to its parent');
  -- last updated: the file's date, moved forward by later imported updates
  PERFORM tracker_test_check((SELECT updated_on FROM tracker_project_plans WHERE group_id = gA AND legacy_id = 'X-1') = '2026-11-05',
                             'imported updates move last updated forward');
  PERFORM tracker_test_check((SELECT updated_on FROM tracker_project_plans WHERE group_id = gA AND legacy_id = 'X-2') = '2026-11-13',
                             'a plan without updates keeps the file date');
  PERFORM tracker_test_check((SELECT summary FROM tracker_project_plans WHERE group_id = gA AND legacy_id = 'X-1') = E'Line one\nLine two',
                             'line breaks kept');
  -- region created in the lookups
  PERFORM tracker_test_check(EXISTS (SELECT 1 FROM tracker_lookups WHERE group_id = gA AND list = 'region' AND key = 'north' AND label = 'North'),
                             'region lookup created');
  -- milestones: baseline = due date, completed status
  PERFORM tracker_test_check((SELECT count(*) FROM tracker_milestones WHERE group_id = gA AND baseline_due_on = due_on) = 2, 'baseline = due');
  PERFORM tracker_test_check((SELECT status FROM tracker_milestones WHERE group_id = gA AND legacy_id = 'first sample') = 'completed', 'milestone done');
  -- actions: contact link, assignee, dates
  PERFORM tracker_test_check((SELECT contact_id IS NOT NULL AND waiting_since = '2026-11-03' AND priority = 'high'
                              FROM tracker_actions WHERE group_id = gA AND legacy_id = 'A-2'), 'waiting action');
  PERFORM tracker_test_check((SELECT assignee_id = u_staff AND due_on IS NULL AND created_on = '2026-10-21'
                              FROM tracker_actions WHERE group_id = gA AND legacy_id = 'A-1'), 'assigned action');
  PERFORM tracker_test_check((SELECT done_on = '2026-11-04' FROM tracker_actions WHERE group_id = gA AND legacy_id = 'A-3'), 'done action');
  -- updates: handover kind, author is the importer
  PERFORM tracker_test_check((SELECT kind = 'handover' AND author_id = u_mgr FROM tracker_updates WHERE group_id = gA AND legacy_id = 'handover:X-1'),
                             'handover note');
  -- review saved as the importer's
  PERFORM tracker_test_check(EXISTS (SELECT 1 FROM tracker_reviews WHERE group_id = gA AND user_id = u_mgr AND iso_week = '2026-W43'), 'review');
  -- job recorded; activity logged as the importer
  PERFORM tracker_test_check((SELECT count(*) FROM tracker_import_jobs WHERE group_id = gA AND status = 'applied'
                              AND created_by = u_mgr AND file_name = 'f.json' AND applied_at IS NOT NULL) = 1, 'job recorded');
  PERFORM tracker_test_check((SELECT count(*) FROM tracker_activity_log WHERE group_id = gA AND entity_type = 'tracker_project_plans'
                              AND verb = 'created' AND actor_id = u_mgr) = 3, 'activity log actor');

  -- ── 3. Same file again: nothing new or changed, no noise in the history ──
  v_log := (SELECT count(*) FROM tracker_activity_log WHERE group_id = gA AND entity_type <> 'tracker_import_jobs');
  PERFORM tracker_test_as(u_mgr);
  s := tracker_import_apply(gA, 'f.json', payload);
  PERFORM tracker_test_check(s->'plans' = '{"new": 0, "changed": 0, "unchanged": 3}', 're-import plans: ' || s::text);
  PERFORM tracker_test_check(s->'actions' = '{"new": 0, "changed": 0, "unchanged": 3}', 're-import actions');
  PERFORM tracker_test_check(s->'updates' = '{"new": 0, "changed": 0, "unchanged": 3}', 're-import updates');
  PERFORM tracker_test_check(s->'contact_links' = '{"new": 0}', 're-import links');
  PERFORM tracker_test_as(NULL);
  PERFORM tracker_test_check((SELECT count(*) FROM tracker_activity_log WHERE group_id = gA AND entity_type <> 'tracker_import_jobs') = v_log,
                             're-import added no history');
  PERFORM tracker_test_check((SELECT count(*) FROM tracker_project_plans WHERE group_id = gA) = 3, 'no duplicate plans');

  -- ── 4. Changed values update; archived stays archived; a NavHub update counts ──
  PERFORM tracker_test_as(u_mgr);
  UPDATE tracker_project_plans SET archived_at = now() WHERE group_id = gA AND legacy_id = 'X-3';
  INSERT INTO tracker_updates (group_id, plan_id, date, source, text)
  SELECT gA, id, '2026-11-18', 'my_note', 'Added in NavHub' FROM tracker_project_plans WHERE group_id = gA AND legacy_id = 'X-1';
  payload := jsonb_set(payload, '{plans,0,status}', '"at_risk"');
  payload := jsonb_set(payload, '{actions,0,title}', '"Write the final report"');
  s := tracker_import_apply(gA, 'f2.json', payload);
  PERFORM tracker_test_check(s->'plans' = '{"new": 0, "changed": 1, "unchanged": 2}', 'changed plan: ' || s::text);
  PERFORM tracker_test_check(s->'actions' = '{"new": 0, "changed": 1, "unchanged": 2}', 'changed action');
  PERFORM tracker_test_as(NULL);
  PERFORM tracker_test_check((SELECT status FROM tracker_project_plans WHERE group_id = gA AND legacy_id = 'X-1') = 'at_risk', 'status updated');
  PERFORM tracker_test_check((SELECT archived_at IS NOT NULL FROM tracker_project_plans WHERE group_id = gA AND legacy_id = 'X-3'), 'still archived');
  PERFORM tracker_test_check((SELECT updated_on FROM tracker_project_plans WHERE group_id = gA AND legacy_id = 'X-1') = '2026-11-18',
                             'a NavHub update counts; re-importing a change does not re-stamp to today');

  -- ── 5. Bad files are refused and save nothing ──
  v_plans := (SELECT count(*) FROM tracker_project_plans WHERE group_id = gA);
  PERFORM tracker_test_as(u_mgr);
  PERFORM tracker_test_refused(format('SELECT tracker_import_apply(%L, %L, %L)', gA, 'bad.json',
    jsonb_build_object('plans', jsonb_build_array(jsonb_build_object('legacy_id', 'X-9', 'name', 'New', 'category', 'no_such_category')))),
    '22023', 'unknown category');
  PERFORM tracker_test_refused(format('SELECT tracker_import_apply(%L, %L, %L)', gA, 'bad.json',
    jsonb_build_object('plans', jsonb_build_array(jsonb_build_object('legacy_id', 'X-9', 'name', 'New', 'category', 'grants', 'owner_id', u_staff)))),
    '42501', 'staff as owner');
  PERFORM tracker_test_refused(format('SELECT tracker_import_apply(%L, %L, %L)', gA, 'bad.json',
    jsonb_build_object('plans', jsonb_build_array(jsonb_build_object('legacy_id', 'X-9', 'name', 'New', 'category', 'grants')),
                       'actions', jsonb_build_array(jsonb_build_object('legacy_id', 'A-9', 'plan_legacy_id', 'X-9', 'title', 'T', 'assignee_id', u_out)))),
    '42501', 'assignee outside the group');
  PERFORM tracker_test_refused(format('SELECT tracker_import_apply(%L, %L, %L)', gA, 'bad.json',
    jsonb_build_object('plans', jsonb_build_array(
      jsonb_build_object('legacy_id', 'X-1', 'name', 'Alpha', 'category', 'grants', 'parent_legacy_id', 'X-2'),
      jsonb_build_object('legacy_id', 'X-2', 'name', 'Alpha North', 'category', 'grants', 'parent_legacy_id', 'X-1')))),
    '22023', 'parent loop');
  PERFORM tracker_test_refused(format('SELECT tracker_import_apply(%L, %L, %L)', gA, 'bad.json',
    jsonb_build_object('plans', jsonb_build_array(jsonb_build_object('legacy_id', 'X-9', 'name', 'New', 'category', 'grants', 'parent_legacy_id', 'X-404')))),
    '22023', 'missing parent');
  PERFORM tracker_test_refused(format('SELECT tracker_import_apply(%L, %L, %L)', gA, 'bad.json',
    jsonb_build_object('actions', jsonb_build_array(jsonb_build_object('legacy_id', 'A-9', 'plan_legacy_id', 'X-404', 'title', 'T')))),
    '22023', 'action for a missing project');
  PERFORM tracker_test_as(NULL);
  PERFORM tracker_test_check((SELECT count(*) FROM tracker_project_plans WHERE group_id = gA) = v_plans, 'refused files saved nothing');
  PERFORM tracker_test_check((SELECT count(*) FROM tracker_import_jobs WHERE group_id = gA) = 3, 'only applied imports recorded');
  PERFORM tracker_test_check((SELECT parent_id IS NULL FROM tracker_project_plans WHERE group_id = gA AND legacy_id = 'X-1'), 'loop rolled back');

  -- ── 6. Import job rows: editors add their own only ──
  PERFORM tracker_test_as(u_mgr);
  INSERT INTO tracker_import_jobs (group_id, file_name, status, created_by) VALUES (gA, 'x.json', 'failed', u_mgr);
  PERFORM tracker_test_refused(format('INSERT INTO tracker_import_jobs (group_id, status, created_by) VALUES (%L, %L, %L)', gA, 'failed', u_own),
                               '42501', 'job for someone else');
  PERFORM tracker_test_as(u_staff);
  PERFORM tracker_test_refused(format('INSERT INTO tracker_import_jobs (group_id, status, created_by) VALUES (%L, %L, %L)', gA, 'failed', u_staff),
                               '42501', 'staff job row');
  PERFORM tracker_test_check((SELECT count(*) FROM tracker_import_jobs) = 0, 'staff cannot read job rows');
  PERFORM tracker_test_as(u_mgr);
  UPDATE tracker_import_jobs SET status = 'cancelled' WHERE group_id = gA;
  GET DIAGNOSTICS v_plans = ROW_COUNT;
  PERFORM tracker_test_check(v_plans = 0, 'job rows cannot be changed');
  DELETE FROM tracker_import_jobs WHERE group_id = gA;
  GET DIAGNOSTICS v_plans = ROW_COUNT;
  PERFORM tracker_test_check(v_plans = 0, 'job rows cannot be deleted');
  PERFORM tracker_test_as(NULL);
END $$;

SELECT 'ALL TRACKER P4 IMPORT TESTS PASSED' AS result;

ROLLBACK;
