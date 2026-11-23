-- Migration 084: Tracker import (P4)
-- ──────────────────────────────────────────────────────────────────────────
-- Applies an import from the previous tracker in one transaction: either all
-- of it is saved or none of it. The app reads the old tracker's export file,
-- translates its values to the agreed lookup keys (lib/tracker/import.ts),
-- shows a preview, and on Apply calls
--
--   tracker_import_apply(p_group_id, p_file_name, p_payload) → jsonb summary
--
-- The function runs as the signed-in user (SECURITY INVOKER), so the access
-- rules from migration 082 still decide: only a Manager or Group Owner can
-- import, a plan's owner must be a Manager or Group Owner, an action's
-- assignee must be a member of the group.
--
-- Records are matched on legacy_id (the old tracker's ids), so importing the
-- same file again updates what changed instead of creating duplicates.
-- Nothing is deleted, and archived plans stay archived.
--
-- Payload (all keys already translated; dates 'YYYY-MM-DD'; ids are uuids):
--   regions    [{ key, label }]                 created in tracker_lookups when missing
--   plans      [{ legacy_id, name, category, status, client, phase, summary,
--                 folder, region, sort_order, owner_id, parent_legacy_id, updated_on }]
--   milestones [{ plan_legacy_id, legacy_id, title, due_on, status, sort_order }]
--   contacts   [{ legacy_id, name, org, role, phone, email, notes,
--                 last_contact, plan_legacy_ids: [..] }]
--   actions    [{ legacy_id, plan_legacy_id, title, type, who, contact_legacy_id,
--                 assignee_id, due_on, status, priority, notes, created_on,
--                 waiting_since, done_on }]
--   updates    [{ legacy_id, plan_legacy_id, kind, date, source, text }]
--   reviews    [{ iso_week, checks }]              saved as the importer's own reviews
--
-- "Last updated": a new plan starts with the old tracker's date, and its
-- imported updates move it forward as usual (079 §5), which matches how the
-- views count it (083: the later of the plan's date and its newest update).
-- Importing again never changes it, and the import itself never counts as an
-- edit (the plan's own re-stamp to today is switched off while importing).
--
-- Also lets Managers and Group Owners record import jobs (tracker_import_jobs).
--
-- Requires migrations 079–083. Only tracker_* objects are touched. Safe to re-run.

-- ── 1. Import job records ───────────────────────────────────────────────────
-- Editors may add a job row for their own import (applied, or failed when the
-- apply was refused). Rows are never changed or deleted by app users.
DROP POLICY IF EXISTS tracker_import_jobs_insert ON tracker_import_jobs;
CREATE POLICY tracker_import_jobs_insert ON tracker_import_jobs FOR INSERT TO authenticated
  WITH CHECK (tracker_is_editor(group_id) AND created_by = (SELECT auth.uid()));

-- ── 2. tracker_import_apply ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION tracker_import_apply(p_group_id uuid, p_file_name text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_missing  text;
  v_summary  jsonb := '{}'::jsonb;
  v_new      int;
  v_changed  int;
  v_total    int;
BEGIN
  IF v_uid IS NULL OR NOT tracker_is_editor(p_group_id) THEN
    RAISE EXCEPTION 'Only a Manager or Group Owner can import projects' USING ERRCODE = '42501';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'The import data is missing' USING ERRCODE = '22023';
  END IF;

  -- Settings and starting lists exist before anything else (no-op when set up).
  PERFORM tracker_init_group(p_group_id);

  -- The import is not an edit: plans aren't re-stamped to today (see 079 §5).
  PERFORM set_config('app.tracker_preserve_updated_on', 'on', true);

  -- ── Regions: add the ones the file uses ──
  INSERT INTO tracker_lookups (group_id, list, key, label, sort_order)
  SELECT p_group_id, 'region', r.v->>'key', COALESCE(r.v->>'label', r.v->>'key'),
         COALESCE((SELECT max(sort_order) FROM tracker_lookups
                   WHERE group_id = p_group_id AND list = 'region'), 0) + r.ord::int
  FROM jsonb_array_elements(COALESCE(p_payload->'regions', '[]')) WITH ORDINALITY AS r(v, ord)
  WHERE r.v->>'key' IS NOT NULL
  ON CONFLICT (group_id, list, key) DO NOTHING;

  -- ── Every key the payload uses must be in the group's lists ──
  SELECT string_agg(DISTINCT format('%s "%s"', u.list, u.key), ', ') INTO v_missing
  FROM (
    SELECT 'category' AS list, p->>'category' AS key FROM jsonb_array_elements(COALESCE(p_payload->'plans', '[]')) p
    UNION ALL SELECT 'status', p->>'status' FROM jsonb_array_elements(COALESCE(p_payload->'plans', '[]')) p
    UNION ALL SELECT 'region', p->>'region' FROM jsonb_array_elements(COALESCE(p_payload->'plans', '[]')) p
    UNION ALL SELECT 'milestone_status', m->>'status' FROM jsonb_array_elements(COALESCE(p_payload->'milestones', '[]')) m
    UNION ALL SELECT 'action_type', a->>'type' FROM jsonb_array_elements(COALESCE(p_payload->'actions', '[]')) a
    UNION ALL SELECT 'source', u->>'source' FROM jsonb_array_elements(COALESCE(p_payload->'updates', '[]')) u
  ) u
  WHERE u.key IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM tracker_lookups l
                    WHERE l.group_id = p_group_id AND l.list = u.list AND l.key = u.key);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'These values are not in the group''s lists: %', v_missing USING ERRCODE = '22023';
  END IF;

  -- ── Plans (parents linked in a second pass) ──
  WITH src AS (
    SELECT * FROM jsonb_to_recordset(COALESCE(p_payload->'plans', '[]')) AS x(
      legacy_id text, name text, category text, status text, client text, phase text,
      summary text, folder text, region text, sort_order int, owner_id uuid, updated_on date)
  ), up AS (
    INSERT INTO tracker_project_plans AS t
      (group_id, legacy_id, name, category, status, client, phase, summary, folder,
       region, sort_order, owner_id, updated_on)
    SELECT p_group_id, legacy_id, name, category, status, client, phase, summary, folder,
           region, COALESCE(sort_order, 0), COALESCE(owner_id, v_uid),
           COALESCE(updated_on, tracker_today(p_group_id))
    FROM src
    ON CONFLICT (group_id, legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
      name = EXCLUDED.name, category = EXCLUDED.category, status = EXCLUDED.status,
      client = EXCLUDED.client, phase = EXCLUDED.phase, summary = EXCLUDED.summary,
      folder = EXCLUDED.folder, region = EXCLUDED.region, sort_order = EXCLUDED.sort_order,
      owner_id = EXCLUDED.owner_id
    WHERE (t.name, t.category, t.status, t.client, t.phase, t.summary, t.folder,
           t.region, t.sort_order, t.owner_id)
      IS DISTINCT FROM
          (EXCLUDED.name, EXCLUDED.category, EXCLUDED.status, EXCLUDED.client, EXCLUDED.phase,
           EXCLUDED.summary, EXCLUDED.folder, EXCLUDED.region, EXCLUDED.sort_order, EXCLUDED.owner_id)
    RETURNING (xmax = 0) AS is_new
  )
  SELECT count(*) FILTER (WHERE is_new), count(*) FILTER (WHERE NOT is_new),
         (SELECT count(*) FROM src)
    INTO v_new, v_changed, v_total FROM up;

  UPDATE tracker_project_plans c
  SET parent_id = par.id
  FROM jsonb_to_recordset(COALESCE(p_payload->'plans', '[]')) AS x(legacy_id text, parent_legacy_id text)
  LEFT JOIN tracker_project_plans par
         ON par.group_id = p_group_id AND par.legacy_id = x.parent_legacy_id
  WHERE c.group_id = p_group_id AND c.legacy_id = x.legacy_id
    AND (x.parent_legacy_id IS NULL OR par.id IS NOT NULL)
    AND c.parent_id IS DISTINCT FROM par.id;

  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(COALESCE(p_payload->'plans', '[]')) AS x(parent_legacy_id text)
             WHERE x.parent_legacy_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM tracker_project_plans par
                               WHERE par.group_id = p_group_id AND par.legacy_id = x.parent_legacy_id)) THEN
    RAISE EXCEPTION 'A sub-project''s parent project is not in the file or in NavHub' USING ERRCODE = '22023';
  END IF;

  -- No project may end up inside one of its own sub-projects.
  IF EXISTS (
    WITH RECURSIVE chain(start_id, id, depth) AS (
      SELECT p.id, p.parent_id, 1 FROM tracker_project_plans p
      WHERE p.group_id = p_group_id AND p.parent_id IS NOT NULL
      UNION ALL
      SELECT c.start_id, p.parent_id, c.depth + 1
      FROM chain c JOIN tracker_project_plans p ON p.id = c.id
      WHERE p.parent_id IS NOT NULL AND c.id <> c.start_id AND c.depth < 100
    )
    SELECT 1 FROM chain WHERE id = start_id) THEN
    RAISE EXCEPTION 'The file makes a project a sub-project of itself' USING ERRCODE = '22023';
  END IF;

  v_summary := v_summary || jsonb_build_object('plans',
    jsonb_build_object('new', v_new, 'changed', v_changed, 'unchanged', v_total - v_new - v_changed));

  -- Every other record must point at a plan of this group.
  SELECT string_agg(DISTINCT k, ', ') INTO v_missing
  FROM (
    SELECT m->>'plan_legacy_id' AS k FROM jsonb_array_elements(COALESCE(p_payload->'milestones', '[]')) m
    UNION ALL SELECT a->>'plan_legacy_id' FROM jsonb_array_elements(COALESCE(p_payload->'actions', '[]')) a
    UNION ALL SELECT u->>'plan_legacy_id' FROM jsonb_array_elements(COALESCE(p_payload->'updates', '[]')) u
    UNION ALL SELECT jsonb_array_elements_text(COALESCE(c->'plan_legacy_ids', '[]'))
              FROM jsonb_array_elements(COALESCE(p_payload->'contacts', '[]')) c
  ) r
  WHERE k IS NULL
     OR NOT EXISTS (SELECT 1 FROM tracker_project_plans p
                    WHERE p.group_id = p_group_id AND p.legacy_id = r.k);
  IF v_missing IS NOT NULL OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(p_payload->'milestones', '[]')
                       || COALESCE(p_payload->'actions', '[]')
                       || COALESCE(p_payload->'updates', '[]')) e
       WHERE e->>'plan_legacy_id' IS NULL) THEN
    RAISE EXCEPTION 'Some records point at a project that is not in the file: %',
      COALESCE(v_missing, '(none given)') USING ERRCODE = '22023';
  END IF;

  -- ── Milestones (the original due date is kept as the baseline) ──
  WITH src AS (
    SELECT p.id AS plan_id, x.*
    FROM jsonb_to_recordset(COALESCE(p_payload->'milestones', '[]')) AS x(
      plan_legacy_id text, legacy_id text, title text, due_on date, status text, sort_order int)
    JOIN tracker_project_plans p ON p.group_id = p_group_id AND p.legacy_id = x.plan_legacy_id
  ), up AS (
    INSERT INTO tracker_milestones AS t
      (group_id, plan_id, legacy_id, title, due_on, baseline_due_on, status, sort_order)
    SELECT p_group_id, plan_id, legacy_id, title, due_on, due_on,
           COALESCE(status, 'planned'), COALESCE(sort_order, 0)
    FROM src
    ON CONFLICT (plan_id, legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
      title = EXCLUDED.title, due_on = EXCLUDED.due_on, status = EXCLUDED.status,
      sort_order = EXCLUDED.sort_order
    WHERE (t.title, t.due_on, t.status, t.sort_order)
      IS DISTINCT FROM (EXCLUDED.title, EXCLUDED.due_on, EXCLUDED.status, EXCLUDED.sort_order)
    RETURNING (xmax = 0) AS is_new
  )
  SELECT count(*) FILTER (WHERE is_new), count(*) FILTER (WHERE NOT is_new),
         (SELECT count(*) FROM src)
    INTO v_new, v_changed, v_total FROM up;
  v_summary := v_summary || jsonb_build_object('milestones',
    jsonb_build_object('new', v_new, 'changed', v_changed, 'unchanged', v_total - v_new - v_changed));

  -- ── Contacts and their project links ──
  WITH src AS (
    SELECT * FROM jsonb_to_recordset(COALESCE(p_payload->'contacts', '[]')) AS x(
      legacy_id text, name text, org text, role text, phone text, email text,
      notes text, last_contact date)
  ), up AS (
    INSERT INTO tracker_contacts AS t
      (group_id, legacy_id, name, org, role, phone, email, notes, last_contact)
    SELECT p_group_id, legacy_id, name, org, role, phone, email, notes, last_contact FROM src
    ON CONFLICT (group_id, legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
      name = EXCLUDED.name, org = EXCLUDED.org, role = EXCLUDED.role, phone = EXCLUDED.phone,
      email = EXCLUDED.email, notes = EXCLUDED.notes, last_contact = EXCLUDED.last_contact
    WHERE (t.name, t.org, t.role, t.phone, t.email, t.notes, t.last_contact)
      IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.org, EXCLUDED.role, EXCLUDED.phone,
                        EXCLUDED.email, EXCLUDED.notes, EXCLUDED.last_contact)
    RETURNING (xmax = 0) AS is_new
  )
  SELECT count(*) FILTER (WHERE is_new), count(*) FILTER (WHERE NOT is_new),
         (SELECT count(*) FROM src)
    INTO v_new, v_changed, v_total FROM up;
  v_summary := v_summary || jsonb_build_object('contacts',
    jsonb_build_object('new', v_new, 'changed', v_changed, 'unchanged', v_total - v_new - v_changed));

  WITH ins AS (
    INSERT INTO tracker_contact_plans (contact_id, plan_id, group_id)
    SELECT DISTINCT c.id, p.id, p_group_id
    FROM jsonb_array_elements(COALESCE(p_payload->'contacts', '[]')) x
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(x->'plan_legacy_ids', '[]')) pl(legacy_id)
    JOIN tracker_contacts c ON c.group_id = p_group_id AND c.legacy_id = x->>'legacy_id'
    JOIN tracker_project_plans p ON p.group_id = p_group_id AND p.legacy_id = pl.legacy_id
    ON CONFLICT (contact_id, plan_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_new FROM ins;
  v_summary := v_summary || jsonb_build_object('contact_links', jsonb_build_object('new', v_new));

  -- ── Actions ──
  WITH src AS (
    SELECT p.id AS plan_id, c.id AS contact_id, x.*
    FROM jsonb_to_recordset(COALESCE(p_payload->'actions', '[]')) AS x(
      legacy_id text, plan_legacy_id text, title text, type text, who text,
      contact_legacy_id text, assignee_id uuid, due_on date, status text, priority text,
      notes text, created_on date, waiting_since date, done_on date)
    JOIN tracker_project_plans p ON p.group_id = p_group_id AND p.legacy_id = x.plan_legacy_id
    LEFT JOIN tracker_contacts c ON c.group_id = p_group_id AND c.legacy_id = x.contact_legacy_id
  ), up AS (
    INSERT INTO tracker_actions AS t
      (group_id, legacy_id, plan_id, title, type, who, contact_id, assignee_id, due_on,
       status, priority, notes, created_on, waiting_since, done_on)
    SELECT p_group_id, legacy_id, plan_id, title, type, who, contact_id, assignee_id, due_on,
           COALESCE(status, 'open')::tracker_action_status, COALESCE(priority, 'normal')::tracker_priority, notes,
           COALESCE(created_on, tracker_today(p_group_id)), waiting_since, done_on
    FROM src
    ON CONFLICT (group_id, legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
      plan_id = EXCLUDED.plan_id, title = EXCLUDED.title, type = EXCLUDED.type,
      who = EXCLUDED.who, contact_id = EXCLUDED.contact_id, assignee_id = EXCLUDED.assignee_id,
      due_on = EXCLUDED.due_on, status = EXCLUDED.status, priority = EXCLUDED.priority,
      notes = EXCLUDED.notes, created_on = EXCLUDED.created_on,
      waiting_since = EXCLUDED.waiting_since, done_on = EXCLUDED.done_on
    WHERE (t.plan_id, t.title, t.type, t.who, t.contact_id, t.assignee_id, t.due_on, t.status,
           t.priority, t.notes, t.created_on, t.waiting_since, t.done_on)
      IS DISTINCT FROM
          (EXCLUDED.plan_id, EXCLUDED.title, EXCLUDED.type, EXCLUDED.who, EXCLUDED.contact_id,
           EXCLUDED.assignee_id, EXCLUDED.due_on, EXCLUDED.status, EXCLUDED.priority,
           EXCLUDED.notes, EXCLUDED.created_on, EXCLUDED.waiting_since, EXCLUDED.done_on)
    RETURNING (xmax = 0) AS is_new
  )
  SELECT count(*) FILTER (WHERE is_new), count(*) FILTER (WHERE NOT is_new),
         (SELECT count(*) FROM src)
    INTO v_new, v_changed, v_total FROM up;
  v_summary := v_summary || jsonb_build_object('actions',
    jsonb_build_object('new', v_new, 'changed', v_changed, 'unchanged', v_total - v_new - v_changed));

  -- ── Updates and handover notes (author: the person importing) ──
  WITH src AS (
    SELECT p.id AS plan_id, x.*
    FROM jsonb_to_recordset(COALESCE(p_payload->'updates', '[]')) AS x(
      legacy_id text, plan_legacy_id text, kind text, date date, source text, "text" text)
    JOIN tracker_project_plans p ON p.group_id = p_group_id AND p.legacy_id = x.plan_legacy_id
  ), up AS (
    INSERT INTO tracker_updates AS t (group_id, plan_id, legacy_id, kind, date, source, "text")
    SELECT p_group_id, plan_id, legacy_id, COALESCE(kind, 'update')::tracker_update_kind,
           COALESCE(date, tracker_today(p_group_id)), source, "text"
    FROM src
    ON CONFLICT (group_id, legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
      plan_id = EXCLUDED.plan_id, kind = EXCLUDED.kind, date = EXCLUDED.date,
      source = EXCLUDED.source, text = EXCLUDED.text
    WHERE (t.plan_id, t.kind, t.date, t.source, t.text)
      IS DISTINCT FROM (EXCLUDED.plan_id, EXCLUDED.kind, EXCLUDED.date, EXCLUDED.source, EXCLUDED.text)
    RETURNING (xmax = 0) AS is_new
  )
  SELECT count(*) FILTER (WHERE is_new), count(*) FILTER (WHERE NOT is_new),
         (SELECT count(*) FROM src)
    INTO v_new, v_changed, v_total FROM up;
  v_summary := v_summary || jsonb_build_object('updates',
    jsonb_build_object('new', v_new, 'changed', v_changed, 'unchanged', v_total - v_new - v_changed));

  -- ── Weekly reviews: saved as the importer's own ──
  WITH up AS (
    INSERT INTO tracker_reviews AS t (group_id, user_id, iso_week, checks)
    SELECT p_group_id, v_uid, x.iso_week, COALESCE(x.checks, '{}')
    FROM jsonb_to_recordset(COALESCE(p_payload->'reviews', '[]')) AS x(iso_week text, checks jsonb)
    ON CONFLICT (group_id, user_id, iso_week) DO UPDATE SET checks = EXCLUDED.checks, updated_at = now()
    WHERE t.checks IS DISTINCT FROM EXCLUDED.checks
    RETURNING 1
  )
  SELECT count(*) INTO v_new FROM up;
  v_summary := v_summary || jsonb_build_object('reviews', jsonb_build_object('saved', v_new));

  PERFORM set_config('app.tracker_preserve_updated_on', 'off', true);

  INSERT INTO tracker_import_jobs (group_id, file_name, status, summary, created_by, applied_at)
  VALUES (p_group_id, p_file_name, 'applied', v_summary, v_uid, now());

  RETURN v_summary;
END;
$$;

REVOKE EXECUTE ON FUNCTION tracker_import_apply(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tracker_import_apply(uuid, text, jsonb) TO authenticated;
