-- Tests for 084_tracker_import.sql. Runs in one transaction and rolls back.
-- Run as the database owner:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/084_tracker_import_test.sql
-- Covers the P4 acceptance criteria at the database level: a Manager previews
-- then applies; a re-import of the same payload changes nothing; a Staff member
-- (and an outsider) is refused; a payload pointing at a missing project / an
-- unknown parent is refused and saves nothing; bad references raise; an already-
-- archived plan stays archived when re-imported; the old updated_on is kept.
-- A clean run prints "ALL TRACKER IMPORT TESTS PASSED".

BEGIN;

DO $$
DECLARE
  g    uuid := '11000000-0000-0000-0000-000000000001';
  g2   uuid := '11000000-0000-0000-0000-000000000002';
  mgr  uuid := '22000000-0000-0000-0000-000000000001';  -- manager of g
  stf  uuid := '22000000-0000-0000-0000-000000000002';  -- staff of g
  out  uuid := '22000000-0000-0000-0000-000000000003';  -- manager of g2 (outsider)
  payload jsonb;
  res  jsonb;
  n    int;
  d    date;
  arch timestamptz;
  ok   boolean;
BEGIN
  INSERT INTO groups (id, name, slug) VALUES
    (g,  'Import test',  'tracker-imp-' || g::text),
    (g2, 'Other group',  'tracker-imp-' || g2::text);
  INSERT INTO auth.users (id) VALUES (mgr), (stf), (out);
  INSERT INTO user_groups (user_id, group_id, role) VALUES
    (mgr, g, 'manager'), (stf, g, 'staff'), (out, g2, 'manager');
  PERFORM tracker_init_group(g);
  PERFORM tracker_init_group(g2);

  -- The payload the translator would produce: two plans (Beta a sub of Alpha,
  -- archived), one new region, a milestone, an action, a contact + link, update.
  payload := jsonb_build_object(
    'regions', jsonb_build_array(jsonb_build_object('key','south_west','label','South West')),
    'plans', jsonb_build_array(
      jsonb_build_object('legacy_id','P1','name','Alpha','status','on_track',
        'category','grants','client',NULL,'phase',NULL,'summary',NULL,'folder',NULL,
        'region','south_west','parent_legacy_id',NULL,'owner_id',mgr::text,'lead_id',NULL,
        'start_on',NULL,'end_on',NULL,'priority','high','progress_pct',50,
        'updated_on','2024-01-10','archived',false),
      jsonb_build_object('legacy_id','P2','name','Beta','status','blocked',
        'category',NULL,'client',NULL,'phase',NULL,'summary',NULL,'folder',NULL,
        'region',NULL,'parent_legacy_id','P1','owner_id',mgr::text,'lead_id',NULL,
        'start_on',NULL,'end_on',NULL,'priority','normal','progress_pct',0,
        'updated_on',NULL,'archived',true)
    ),
    'milestones', jsonb_build_array(
      jsonb_build_object('legacy_id','M1','plan_legacy_id','P1','title','Kickoff',
        'title_hash','abcd1234','description',NULL,'status','completed','owner_id',NULL,
        'start_on',NULL,'due_on','2024-02-01','completed_on',NULL,'progress_pct',100,
        'priority','normal')
    ),
    'actions', jsonb_build_array(
      jsonb_build_object('legacy_id','A1','plan_legacy_id','P1','milestone_legacy_id','M1',
        'title','Call client','type','call','who',NULL,'assignee_id',NULL,
        'contact_legacy_id','C1','due_on','2024-01-20','status','open','priority','normal',
        'notes',NULL,'waiting_since',NULL,'done_on',NULL)
    ),
    'contacts', jsonb_build_array(
      jsonb_build_object('legacy_id','C1','name','Bob Client','org','Acme','role',NULL,
        'phone',NULL,'email',NULL,'notes',NULL,'last_contact',NULL,'owner_id',NULL)
    ),
    'contact_links', jsonb_build_array(
      jsonb_build_object('contact_legacy_id','C1','plan_legacy_id','P1')
    ),
    'updates', jsonb_build_array(
      jsonb_build_object('legacy_id','U1','plan_legacy_id','P1','kind','update',
        'date','2024-01-05','source','email','text','Started')
    )
  );

  -- 1. Staff is refused (editor guard → 42501); nothing saved.
  PERFORM set_config('request.jwt.claim.sub', stf::text, true);
  PERFORM set_config('role', 'authenticated', true);
  ok := false;
  BEGIN
    PERFORM tracker_import_apply(g, 'f.json', payload);
  EXCEPTION WHEN insufficient_privilege THEN ok := true;
  END;
  PERFORM set_config('role', 'none', true);
  IF NOT ok THEN RAISE EXCEPTION '1: staff was NOT refused'; END IF;
  SELECT count(*) INTO n FROM tracker_project_plans WHERE group_id = g;
  IF n <> 0 THEN RAISE EXCEPTION '1: a refused import saved % plans', n; END IF;

  -- 2. An outsider (manager of another group) is refused too.
  PERFORM set_config('request.jwt.claim.sub', out::text, true);
  PERFORM set_config('role', 'authenticated', true);
  ok := false;
  BEGIN
    PERFORM tracker_import_apply(g, 'f.json', payload);
  EXCEPTION WHEN insufficient_privilege THEN ok := true;
  END;
  PERFORM set_config('role', 'none', true);
  IF NOT ok THEN RAISE EXCEPTION '2: outsider was NOT refused'; END IF;

  -- 3. The manager imports: everything lands.
  PERFORM set_config('request.jwt.claim.sub', mgr::text, true);
  PERFORM set_config('role', 'authenticated', true);
  res := tracker_import_apply(g, 'alpha.json', payload);
  PERFORM set_config('role', 'none', true);

  SELECT count(*) INTO n FROM tracker_project_plans WHERE group_id = g;
  IF n <> 2 THEN RAISE EXCEPTION '3: expected 2 plans, got %', n; END IF;
  -- Parent wired, archive set, old updated_on preserved, region added.
  PERFORM 1 FROM tracker_project_plans c
    JOIN tracker_project_plans p ON p.id = c.parent_id
    WHERE c.group_id = g AND c.legacy_id = 'P2' AND p.legacy_id = 'P1';
  IF NOT FOUND THEN RAISE EXCEPTION '3: parent not wired'; END IF;
  SELECT archived_at, updated_on INTO arch, d FROM tracker_project_plans
    WHERE group_id = g AND legacy_id = 'P2';
  IF arch IS NULL THEN RAISE EXCEPTION '3: archived plan not archived'; END IF;
  SELECT updated_on INTO d FROM tracker_project_plans WHERE group_id = g AND legacy_id = 'P1';
  IF d <> date '2024-01-10' THEN RAISE EXCEPTION '3: updated_on not preserved, got %', d; END IF;
  PERFORM 1 FROM tracker_lookups WHERE group_id = g AND list = 'region' AND key = 'south_west';
  IF NOT FOUND THEN RAISE EXCEPTION '3: new region not added'; END IF;
  SELECT count(*) INTO n FROM tracker_milestones WHERE group_id = g;
  IF n <> 1 THEN RAISE EXCEPTION '3: expected 1 milestone, got %', n; END IF;
  SELECT count(*) INTO n FROM tracker_actions WHERE group_id = g;
  IF n <> 1 THEN RAISE EXCEPTION '3: expected 1 action, got %', n; END IF;
  -- Action linked to its contact.
  PERFORM 1 FROM tracker_actions a JOIN tracker_contacts c ON c.id = a.contact_id
    WHERE a.group_id = g AND a.legacy_id = 'A1' AND c.legacy_id = 'C1';
  IF NOT FOUND THEN RAISE EXCEPTION '3: action not linked to contact'; END IF;
  SELECT count(*) INTO n FROM tracker_contact_plans WHERE group_id = g;
  IF n <> 1 THEN RAISE EXCEPTION '3: expected 1 contact link, got %', n; END IF;
  SELECT count(*) INTO n FROM tracker_updates WHERE group_id = g;
  IF n <> 1 THEN RAISE EXCEPTION '3: expected 1 update, got %', n; END IF;
  -- An applied job was recorded.
  PERFORM 1 FROM tracker_import_jobs WHERE group_id = g AND status = 'applied' AND file_name = 'alpha.json';
  IF NOT FOUND THEN RAISE EXCEPTION '3: no applied job recorded'; END IF;

  -- 4. Re-importing the SAME payload changes nothing (counts stay put; update
  --    becomes all-updated, no new rows).
  PERFORM set_config('request.jwt.claim.sub', mgr::text, true);
  PERFORM set_config('role', 'authenticated', true);
  res := tracker_import_apply(g, 'alpha.json', payload);
  PERFORM set_config('role', 'none', true);
  SELECT count(*) INTO n FROM tracker_project_plans WHERE group_id = g;
  IF n <> 2 THEN RAISE EXCEPTION '4: re-import duplicated plans (% now)', n; END IF;
  SELECT count(*) INTO n FROM tracker_milestones WHERE group_id = g;
  IF n <> 1 THEN RAISE EXCEPTION '4: re-import duplicated milestones (%)', n; END IF;
  SELECT count(*) INTO n FROM tracker_actions WHERE group_id = g;
  IF n <> 1 THEN RAISE EXCEPTION '4: re-import duplicated actions (%)', n; END IF;
  SELECT count(*) INTO n FROM tracker_contact_plans WHERE group_id = g;
  IF n <> 1 THEN RAISE EXCEPTION '4: re-import duplicated contact links (%)', n; END IF;
  IF (res->'plans'->>'inserted')::int <> 0 THEN RAISE EXCEPTION '4: re-import inserted plans'; END IF;
  IF (res->'plans'->>'updated')::int <> 2 THEN RAISE EXCEPTION '4: re-import did not update plans'; END IF;
  IF (res->'regions'->>'inserted')::int <> 0 THEN RAISE EXCEPTION '4: re-import re-added a region'; END IF;

  -- 5. An already-archived plan stays archived when the file omits the archive
  --    flag (brief: imports never un-archive).
  PERFORM set_config('request.jwt.claim.sub', mgr::text, true);
  PERFORM set_config('role', 'authenticated', true);
  res := tracker_import_apply(g, 'alpha.json',
    jsonb_set(payload, '{plans,1,archived}', 'false'::jsonb));
  PERFORM set_config('role', 'none', true);
  SELECT archived_at INTO arch FROM tracker_project_plans WHERE group_id = g AND legacy_id = 'P2';
  IF arch IS NULL THEN RAISE EXCEPTION '5: re-import un-archived an archived plan'; END IF;

  -- 6. A milestone pointing at a missing project is refused, and the failed
  --    attempt saves no new rows for that call.
  PERFORM set_config('request.jwt.claim.sub', mgr::text, true);
  PERFORM set_config('role', 'authenticated', true);
  ok := false;
  BEGIN
    PERFORM tracker_import_apply(g, 'bad.json', jsonb_build_object(
      'milestones', jsonb_build_array(jsonb_build_object(
        'legacy_id','MX','plan_legacy_id','GONE','title','Orphan','status','backlog',
        'progress_pct',0,'priority','normal'))));
  EXCEPTION WHEN others THEN ok := true;
  END;
  PERFORM set_config('role', 'none', true);
  IF NOT ok THEN RAISE EXCEPTION '6: a missing-project milestone was NOT refused'; END IF;
  SELECT count(*) INTO n FROM tracker_milestones WHERE group_id = g;
  IF n <> 1 THEN RAISE EXCEPTION '6: a refused import left extra milestones (%)', n; END IF;

  -- 7. An unknown parent reference is refused.
  PERFORM set_config('request.jwt.claim.sub', mgr::text, true);
  PERFORM set_config('role', 'authenticated', true);
  ok := false;
  BEGIN
    PERFORM tracker_import_apply(g, 'bad2.json', jsonb_build_object(
      'plans', jsonb_build_array(jsonb_build_object(
        'legacy_id','PZ','name','Zeta','owner_id',mgr::text,
        'parent_legacy_id','NOPE','priority','normal','progress_pct',0,'archived',false))));
  EXCEPTION WHEN others THEN ok := true;
  END;
  PERFORM set_config('role', 'none', true);
  IF NOT ok THEN RAISE EXCEPTION '7: an unknown parent was NOT refused'; END IF;
  PERFORM 1 FROM tracker_project_plans WHERE group_id = g AND legacy_id = 'PZ';
  IF FOUND THEN RAISE EXCEPTION '7: a refused import saved the bad plan'; END IF;

  -- 8. A direct parent loop is refused by the cycle check.
  PERFORM set_config('request.jwt.claim.sub', mgr::text, true);
  PERFORM set_config('role', 'authenticated', true);
  ok := false;
  BEGIN
    PERFORM tracker_import_apply(g, 'loop.json', jsonb_build_object(
      'plans', jsonb_build_array(
        jsonb_build_object('legacy_id','LX','name','LX','owner_id',mgr::text,
          'parent_legacy_id','LY','priority','normal','progress_pct',0,'archived',false),
        jsonb_build_object('legacy_id','LY','name','LY','owner_id',mgr::text,
          'parent_legacy_id','LX','priority','normal','progress_pct',0,'archived',false))));
  EXCEPTION WHEN others THEN ok := true;
  END;
  PERFORM set_config('role', 'none', true);
  IF NOT ok THEN RAISE EXCEPTION '8: a parent loop was NOT refused'; END IF;

  -- 9. The INSERT policy lets an editor record a job, and refuses a non-editor.
  PERFORM set_config('request.jwt.claim.sub', mgr::text, true);
  PERFORM set_config('role', 'authenticated', true);
  INSERT INTO tracker_import_jobs (group_id, file_name, status) VALUES (g, 'manual.json', 'previewed');
  PERFORM set_config('role', 'none', true);
  PERFORM set_config('request.jwt.claim.sub', stf::text, true);
  PERFORM set_config('role', 'authenticated', true);
  ok := false;
  BEGIN
    INSERT INTO tracker_import_jobs (group_id, file_name, status) VALUES (g, 'sneaky.json', 'previewed');
  EXCEPTION WHEN insufficient_privilege THEN ok := true;
  END;
  PERFORM set_config('role', 'none', true);
  IF NOT ok THEN RAISE EXCEPTION '9: a non-editor could insert an import job'; END IF;

  RAISE WARNING 'ALL TRACKER IMPORT TESTS PASSED';
END $$;

ROLLBACK;
