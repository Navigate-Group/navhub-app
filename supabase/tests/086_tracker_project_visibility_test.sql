-- Tests for 086_tracker_project_visibility.sql. Runs in one transaction and rolls back.
-- Run as the database owner (e.g. postgres), after migrations 079–086:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/086_tracker_project_visibility_test.sql
-- Each check signs in as a test user (role authenticated + JWT sub claim). All data is made up.
-- A clean run prints "ALL TRACKER VISIBILITY TESTS PASSED".
BEGIN;

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

CREATE FUNCTION tracker_test_count(p_sql text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  EXECUTE p_sql INTO n;
  RETURN n;
END $$;

CREATE FUNCTION tracker_test_check(p_ok boolean, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAILED: %', p_label;
  END IF;
END $$;

DO $$
DECLARE
  g  uuid := gen_random_uuid();
  g2 uuid := gen_random_uuid();
  u_mgr  uuid := gen_random_uuid();  -- manager: sees everything
  u_own  uuid := gen_random_uuid();  -- group owner: sees everything
  u_lead uuid := gen_random_uuid();  -- staff, Lead of P1
  u_mem  uuid := gen_random_uuid();  -- staff, Member of P2
  u_shr  uuid := gen_random_uuid();  -- staff, Comment access on P3 (parent of P3a)
  u_asg  uuid := gen_random_uuid();  -- staff, only assigned an action on P1
  u_none uuid := gen_random_uuid();  -- staff, nothing
  u_adm  uuid := gen_random_uuid();  -- group admin, nothing
  u_vw   uuid := gen_random_uuid();  -- viewer, nothing
  u_out  uuid := gen_random_uuid();  -- manager of another group
  p1 uuid; p2 uuid; p3 uuid; p3a uuid; p4 uuid; pnew uuid;
  a1 uuid; a_asg uuid; a_free uuid;
  c1 uuid; c2 uuid; c4 uuid; c_own uuid; c_new uuid;
  r record;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_mgr, 'mgr@example.test'), (u_own, 'own@example.test'), (u_lead, 'lead@example.test'),
    (u_mem, 'mem@example.test'), (u_shr, 'shr@example.test'), (u_asg, 'asg@example.test'),
    (u_none, 'none@example.test'), (u_adm, 'adm@example.test'), (u_vw, 'vw@example.test'),
    (u_out, 'out@example.test');
  INSERT INTO groups (id, name, slug) VALUES (g, 'Group', 'vis-g'), (g2, 'Other', 'vis-g2');
  INSERT INTO user_groups (user_id, group_id, role, is_default) VALUES
    (u_mgr, g, 'manager', true), (u_own, g, 'group_owner', true), (u_lead, g, 'staff', true),
    (u_mem, g, 'staff', true), (u_shr, g, 'staff', true), (u_asg, g, 'staff', true),
    (u_none, g, 'staff', true), (u_adm, g, 'group_admin', true), (u_vw, g, 'viewer', true),
    (u_out, g2, 'manager', true);
  PERFORM tracker_init_group(g);
  PERFORM tracker_init_group(g2);

  -- Setup as the database owner.
  INSERT INTO tracker_project_plans (group_id, name, category, owner_id, lead_id) VALUES (g, 'P1', 'grants', u_mgr, u_lead) RETURNING id INTO p1;
  INSERT INTO tracker_project_plans (group_id, name, category, owner_id) VALUES (g, 'P2', 'grants', u_mgr) RETURNING id INTO p2;
  INSERT INTO tracker_project_plans (group_id, name, category, owner_id) VALUES (g, 'P3', 'grants', u_mgr) RETURNING id INTO p3;
  INSERT INTO tracker_project_plans (group_id, name, category, owner_id, parent_id) VALUES (g, 'P3a', 'grants', u_mgr, p3) RETURNING id INTO p3a;
  INSERT INTO tracker_project_plans (group_id, name, category, owner_id) VALUES (g, 'P4', 'grants', u_mgr) RETURNING id INTO p4;
  INSERT INTO tracker_plan_members (plan_id, user_id, role) VALUES (p2, u_mem, 'member');
  INSERT INTO tracker_plan_shares (plan_id, user_id, level) VALUES (p3, u_shr, 'comment');

  INSERT INTO tracker_milestones (group_id, plan_id, title) VALUES (g, p1, 'M1'), (g, p2, 'M2'), (g, p4, 'M4');
  INSERT INTO tracker_actions (group_id, plan_id, title) VALUES (g, p1, 'A1') RETURNING id INTO a1;
  INSERT INTO tracker_actions (group_id, plan_id, title, assignee_id) VALUES (g, p1, 'Assigned', u_asg) RETURNING id INTO a_asg;
  INSERT INTO tracker_actions (group_id, title, assignee_id) VALUES (g, 'Plan-less', u_none) RETURNING id INTO a_free;
  INSERT INTO tracker_actions (group_id, plan_id, title) VALUES (g, p4, 'A4');
  INSERT INTO tracker_updates (group_id, plan_id, text) VALUES (g, p1, 'U1'), (g, p4, 'U4');
  INSERT INTO tracker_comments (group_id, plan_id, entity_type, entity_id, body, author_id) VALUES (g, p1, 'plan', p1, 'C on P1', u_mgr), (g, p4, 'plan', p4, 'C on P4', u_mgr);
  INSERT INTO tracker_contacts (group_id, name) VALUES (g, 'Contact on P1') RETURNING id INTO c1;
  INSERT INTO tracker_contacts (group_id, name) VALUES (g, 'Contact on P2') RETURNING id INTO c2;
  INSERT INTO tracker_contacts (group_id, name) VALUES (g, 'Contact on P4') RETURNING id INTO c4;
  INSERT INTO tracker_contacts (group_id, name, created_by) VALUES (g, 'Added by shr, no project', u_shr) RETURNING id INTO c_own;
  INSERT INTO tracker_contact_plans (contact_id, plan_id, group_id) VALUES (c1, p1, g), (c2, p2, g), (c4, p4, g);
  UPDATE tracker_actions SET contact_id = c4 WHERE id = a_asg;  -- assignee's action is with a P4 contact

  -- ── 1. Managers and Group Owners see every project ────────────────────────
  FOR r IN SELECT unnest(ARRAY[u_mgr, u_own]) AS u LOOP
    PERFORM tracker_test_as(r.u);
    PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_project_plans WHERE group_id = %L', g)) = 5, '1: an editor does not see all 5 projects');
    PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_actions WHERE group_id = %L', g)) = 4, '1: an editor does not see all 4 actions');
    PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_contacts WHERE group_id = %L', g)) = 4, '1: an editor does not see all 4 contacts');
  END LOOP;

  -- ── 2. Lead sees only their project and its contents ──────────────────────
  PERFORM tracker_test_as(u_lead);
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_project_plans WHERE group_id = %L', g)) = 1, '2: lead sees other projects');
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_project_plans WHERE id = %L', p1)) = 1, '2: lead cannot see P1');
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_milestones WHERE group_id = %L', g)) = 1, '2: lead sees milestones outside P1');
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_actions WHERE group_id = %L', g)) = 2, '2: lead does not see exactly P1''s 2 actions');
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_updates WHERE group_id = %L', g)) = 1, '2: lead sees updates outside P1');
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_comments WHERE group_id = %L', g)) = 1, '2: lead sees comments outside P1');
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_contacts WHERE group_id = %L', g)) = 1, '2: lead does not see exactly P1''s contact');
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_contact_plans WHERE group_id = %L', g)) = 1, '2: lead sees contact links outside P1');
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_activity_log WHERE group_id = %L AND plan_id IS NOT NULL AND plan_id <> %L', g, p1)) = 0, '2: lead sees history of other projects');
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_v_plan_attention WHERE group_id = %L', g)) = 1, '2: lead sees other projects in the attention view');
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_v_milestone_progress WHERE plan_id = %L', p4)) = 0, '2: lead sees P4 milestone progress');

  -- ── 3. Member sees their project ──────────────────────────────────────────
  PERFORM tracker_test_as(u_mem);
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_project_plans WHERE group_id = %L', g)) = 1, '3: member does not see exactly P2');
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_contacts WHERE id = %L', c2)) = 1, '3: member cannot see P2''s contact');

  -- ── 4. Access on a parent covers its sub-projects ─────────────────────────
  PERFORM tracker_test_as(u_shr);
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_project_plans WHERE id IN (%L, %L)', p3, p3a)) = 2, '4: parent access does not show the sub-project');
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_project_plans WHERE group_id = %L', g)) = 2, '4: share sees other projects');
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_contacts WHERE id = %L', c_own)) = 1, '4: cannot see a contact they added');
  -- Comment access still works on the sub-project (unchanged rule).
  INSERT INTO tracker_comments (group_id, plan_id, entity_type, entity_id, body) VALUES (g, p3a, 'plan', p3a, 'hello');
  -- A new contact they add is visible to them straight away (INSERT … RETURNING).
  PERFORM tracker_test_as(NULL);
  INSERT INTO tracker_plan_shares (plan_id, user_id, level) VALUES (p3, u_lead, 'edit');  -- give u_lead Edit somewhere so they may add contacts
  PERFORM tracker_test_as(u_lead);
  INSERT INTO tracker_contacts (group_id, name) VALUES (g, 'Brand new') RETURNING id INTO c_new;
  PERFORM tracker_test_check(c_new IS NOT NULL, '4: a new contact could not be added and returned');

  -- ── 5. Assignee sees their action, not the project ────────────────────────
  PERFORM tracker_test_as(u_asg);
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_project_plans WHERE group_id = %L', g)) = 0, '5: assignee sees projects');
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_actions WHERE group_id = %L', g)) = 1, '5: assignee does not see exactly their own action');
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_milestones WHERE group_id = %L', g)) = 0, '5: assignee sees milestones');
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_contacts WHERE id = %L', c4)) = 1, '5: assignee cannot see the contact on their action');
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_my_action_plans(%L) WHERE id = %L AND name = %L', g, p1, 'P1')) = 1, '5: my-action project names do not include P1');
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_my_action_plans(%L)', g)) = 1, '5: my-action project names include other projects');
  UPDATE tracker_actions SET status = 'done' WHERE id = a_asg;  -- the assignee's quick change still works
  PERFORM tracker_test_as(NULL);
  PERFORM tracker_test_check((SELECT status = 'done' FROM tracker_actions WHERE id = a_asg), '5: assignee could not close their action');

  -- ── 6. Plan-less action: its assignee and editors only ────────────────────
  PERFORM tracker_test_as(u_none);
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_actions WHERE id = %L', a_free)) = 1, '6: assignee cannot see their plan-less action');
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_project_plans WHERE group_id = %L', g)) = 0, '6: staff with nothing sees projects');
  PERFORM tracker_test_as(u_lead);
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_actions WHERE id = %L', a_free)) = 0, '6: another staff sees someone''s plan-less action');

  -- ── 7. Group Admin and Viewer with nothing see nothing ────────────────────
  FOR r IN SELECT unnest(ARRAY[u_adm, u_vw]) AS u LOOP
    PERFORM tracker_test_as(r.u);
    PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_project_plans WHERE group_id = %L', g)) = 0, '7: a role with no projects sees projects');
    PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_contacts WHERE group_id = %L', g)) = 0, '7: a role with no projects sees contacts');
    PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_lookups WHERE group_id = %L', g)) > 0, '7: a member cannot read the lists');
  END LOOP;

  -- ── 8. Other groups and removal ───────────────────────────────────────────
  PERFORM tracker_test_as(u_out);
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_project_plans WHERE group_id = %L', g)) = 0, '8: another group''s manager sees projects');
  PERFORM tracker_test_as(NULL);
  DELETE FROM tracker_plan_members WHERE plan_id = p2 AND user_id = u_mem;
  PERFORM tracker_test_as(u_mem);
  PERFORM tracker_test_check(tracker_test_count(format('SELECT count(*) FROM tracker_project_plans WHERE group_id = %L', g)) = 0, '8: removed member still sees the project');

  -- ── 9. A Manager can still create a project (INSERT … RETURNING) ──────────
  PERFORM tracker_test_as(u_mgr);
  INSERT INTO tracker_project_plans (group_id, name, category, owner_id) VALUES (g, 'New', 'grants', u_mgr) RETURNING id INTO pnew;
  PERFORM tracker_test_check(pnew IS NOT NULL, '9: a manager could not create and return a project');
  PERFORM tracker_test_as(NULL);
END $$;

SELECT 'ALL TRACKER VISIBILITY TESTS PASSED' AS result;

ROLLBACK;
