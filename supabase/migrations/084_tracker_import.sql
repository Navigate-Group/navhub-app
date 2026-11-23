-- Migration 084: Tracker import from the previous system (P4)
-- ──────────────────────────────────────────────────────────────────────────
-- The apply side of the tracker import. The translator (lib/tracker/import.ts)
-- turns the old tracker's export into a NavHub-shaped JSON payload; this
-- migration adds:
--
--   • an INSERT policy on tracker_import_jobs (an editor may record their own
--     import job; the SELECT policy is already in 082);
--   • tracker_import_apply(p_group_id, p_file_name, p_payload) — a single
--     transaction that upserts plans, milestones, actions, contacts and
--     contact→plan links and updates/reviews, all matched on the OLD tracker's
--     ids (legacy_id), adds any new regions to tracker_lookups, and RAISES if a
--     key is unknown, a parent is missing or forms a loop, or a record points
--     at a missing project.
--
-- The function is SECURITY INVOKER (the default): it runs as the signed-in
-- user, so migration 082's RLS and guards decide every write — a Staff / Viewer
-- / other-group member is refused by the database, not merely the UI. It only
-- ADDS and UPDATES; it never deletes. The old tracker's updated_on is preserved
-- (app.tracker_preserve_updated_on = 'on') so imports don't re-stamp plans to
-- today.
--
-- Requires migrations 079–083. Only tracker_* objects are touched. Idempotent:
-- the policy and the function are dropped / replaced, and the function itself is
-- safe to re-run against the same file (upsert on legacy_id).

-- ── 1. tracker_import_jobs: let an editor record their own import ────────────
-- 082 added the editor-only SELECT policy; P4 adds the INSERT. An editor may
-- insert a job row for their own group, attributed to themselves. Preview /
-- apply / failed rows all go through this one policy.
DROP POLICY IF EXISTS tracker_import_jobs_insert ON tracker_import_jobs;
CREATE POLICY tracker_import_jobs_insert ON tracker_import_jobs FOR INSERT TO authenticated
  WITH CHECK (
    tracker_is_editor(group_id)
    AND (created_by IS NULL OR created_by = (SELECT auth.uid()))
  );

-- ── 2. tracker_import_apply ─────────────────────────────────────────────────
-- Upserts everything in p_payload. Runs as the caller (SECURITY INVOKER) so
-- RLS from 082 applies; the first guard is an explicit editor check so a
-- non-editor gets a clear 42501 instead of a vaguer RLS refusal partway in.
--
-- Payload shape (NavHub keys, ids matched on legacy_id) — see lib/tracker/import.ts:
--   { regions:[{key,label}], plans:[…], milestones:[…], actions:[…],
--     contacts:[…], contact_links:[{contact_legacy_id,plan_legacy_id}],
--     updates:[…] }
--
-- Returns a jsonb summary of what was inserted / updated per entity.

CREATE OR REPLACE FUNCTION tracker_import_apply(
  p_group_id uuid,
  p_file_name text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
-- SECURITY INVOKER (default): run as the signed-in user so RLS/guards decide.
SET search_path = public, pg_temp
AS $$
DECLARE
  rec            jsonb;
  v_now          timestamptz := now();
  -- legacy_id → new uuid, per entity, so children can resolve their parents.
  plan_id_of     jsonb := '{}'::jsonb;
  ms_id_of       jsonb := '{}'::jsonb;
  contact_id_of  jsonb := '{}'::jsonb;
  v_id           uuid;
  v_parent       text;
  v_parent_id    uuid;
  v_status       text;
  v_region       text;
  -- counts
  c_plans_ins    int := 0;  c_plans_upd    int := 0;
  c_ms_ins       int := 0;  c_ms_upd       int := 0;
  c_act_ins      int := 0;  c_act_upd      int := 0;
  c_con_ins      int := 0;  c_con_upd      int := 0;
  c_link_ins     int := 0;
  c_upd_ins      int := 0;  c_upd_upd      int := 0;
  c_region_ins   int := 0;
  v_existing_id  uuid;
BEGIN
  -- Only a Manager or Group Owner of the group may import.
  IF NOT tracker_is_editor(p_group_id) THEN
    RAISE EXCEPTION 'Only a Manager or Group Owner can import projects for this group'
      USING ERRCODE = '42501';
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'The import payload is missing or not an object';
  END IF;

  -- Preserve the old tracker's updated_on: stop the plan last-updated trigger
  -- re-stamping plans to today while we import.
  PERFORM set_config('app.tracker_preserve_updated_on', 'on', true);

  -- ── Regions: add any new ones to tracker_lookups (idempotent) ─────────────
  FOR rec IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'regions', '[]'::jsonb)) LOOP
    IF COALESCE(rec->>'key','') = '' THEN CONTINUE; END IF;
    INSERT INTO tracker_lookups (group_id, list, key, label, sort_order, active)
    VALUES (
      p_group_id, 'region', rec->>'key', COALESCE(rec->>'label', rec->>'key'),
      COALESCE((SELECT max(sort_order) + 1 FROM tracker_lookups
                WHERE group_id = p_group_id AND list = 'region'), 0),
      true
    )
    ON CONFLICT (group_id, list, key) DO NOTHING;
    IF FOUND THEN c_region_ins := c_region_ins + 1; END IF;
  END LOOP;

  -- ── Plans: upsert on (group_id, legacy_id). Parents resolved in a 2nd pass ─
  -- First pass: insert / update every plan WITHOUT its parent, so a parent that
  -- appears later in the array still resolves. The owner must already be an
  -- editor (the plan guard enforces this too).
  FOR rec IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'plans', '[]'::jsonb)) LOOP
    IF COALESCE(rec->>'legacy_id','') = '' THEN
      RAISE EXCEPTION 'A project in the file has no id';
    END IF;
    IF COALESCE(rec->>'owner_id','') = '' THEN
      RAISE EXCEPTION 'Project "%" has no owner chosen', COALESCE(rec->>'name','?');
    END IF;

    SELECT id INTO v_existing_id FROM tracker_project_plans
      WHERE group_id = p_group_id AND legacy_id = rec->>'legacy_id';

    IF v_existing_id IS NULL THEN
      INSERT INTO tracker_project_plans (
        group_id, legacy_id, name, status, category, client, phase, summary,
        folder, region, owner_id, lead_id, start_on, end_on, priority,
        progress_pct, updated_on, archived_at
      ) VALUES (
        p_group_id, rec->>'legacy_id', rec->>'name',
        NULLIF(rec->>'status',''), NULLIF(rec->>'category',''),
        NULLIF(rec->>'client',''), NULLIF(rec->>'phase',''),
        NULLIF(rec->>'summary',''), NULLIF(rec->>'folder',''),
        NULLIF(rec->>'region',''),
        (rec->>'owner_id')::uuid, NULLIF(rec->>'lead_id','')::uuid,
        NULLIF(rec->>'start_on','')::date, NULLIF(rec->>'end_on','')::date,
        COALESCE(NULLIF(rec->>'priority',''),'normal')::tracker_priority,
        COALESCE((rec->>'progress_pct')::int, 0),
        COALESCE(NULLIF(rec->>'updated_on','')::date, (v_now AT TIME ZONE 'Australia/Perth')::date),
        CASE WHEN (rec->>'archived')::boolean THEN v_now ELSE NULL END
      )
      RETURNING id INTO v_id;
      c_plans_ins := c_plans_ins + 1;
    ELSE
      v_id := v_existing_id;
      UPDATE tracker_project_plans SET
        name = rec->>'name',
        status = NULLIF(rec->>'status',''),
        category = NULLIF(rec->>'category',''),
        client = NULLIF(rec->>'client',''),
        phase = NULLIF(rec->>'phase',''),
        summary = NULLIF(rec->>'summary',''),
        folder = NULLIF(rec->>'folder',''),
        region = NULLIF(rec->>'region',''),
        owner_id = (rec->>'owner_id')::uuid,
        lead_id = NULLIF(rec->>'lead_id','')::uuid,
        start_on = NULLIF(rec->>'start_on','')::date,
        end_on = NULLIF(rec->>'end_on','')::date,
        priority = COALESCE(NULLIF(rec->>'priority',''),'normal')::tracker_priority,
        progress_pct = COALESCE((rec->>'progress_pct')::int, 0),
        updated_on = COALESCE(NULLIF(rec->>'updated_on','')::date, updated_on),
        -- Archive only moves archived → archived or unarchived → archived here;
        -- an already-archived plan STAYS archived even if the file omits it.
        archived_at = CASE
          WHEN (rec->>'archived')::boolean THEN COALESCE(archived_at, v_now)
          ELSE archived_at
        END
      WHERE id = v_id;
      c_plans_upd := c_plans_upd + 1;
    END IF;

    plan_id_of := plan_id_of || jsonb_build_object(rec->>'legacy_id', v_id::text);
  END LOOP;

  -- Second pass: set parents now every plan id is known. A parent legacy id not
  -- resolvable (not in the file and not already imported) is an error.
  FOR rec IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'plans', '[]'::jsonb)) LOOP
    v_parent := NULLIF(rec->>'parent_legacy_id','');
    IF v_parent IS NULL THEN CONTINUE; END IF;

    v_parent_id := NULL;
    IF plan_id_of ? v_parent THEN
      v_parent_id := (plan_id_of->>v_parent)::uuid;
    ELSE
      SELECT id INTO v_parent_id FROM tracker_project_plans
        WHERE group_id = p_group_id AND legacy_id = v_parent;
    END IF;

    IF v_parent_id IS NULL THEN
      RAISE EXCEPTION 'Project "%" points at a parent (%) that does not exist',
        COALESCE(rec->>'name','?'), v_parent;
    END IF;

    v_id := (plan_id_of->>(rec->>'legacy_id'))::uuid;
    IF v_parent_id = v_id THEN
      RAISE EXCEPTION 'Project "%" cannot be its own parent', COALESCE(rec->>'name','?');
    END IF;

    UPDATE tracker_project_plans SET parent_id = v_parent_id WHERE id = v_id;
  END LOOP;

  -- Loop guard: after wiring parents, no plan may reach itself through its chain.
  PERFORM tracker_import_check_no_cycles(p_group_id);

  -- ── Contacts: upsert on (group_id, legacy_id) ─────────────────────────────
  FOR rec IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'contacts', '[]'::jsonb)) LOOP
    IF COALESCE(rec->>'legacy_id','') = '' THEN
      RAISE EXCEPTION 'A contact in the file has no id';
    END IF;
    SELECT id INTO v_existing_id FROM tracker_contacts
      WHERE group_id = p_group_id AND legacy_id = rec->>'legacy_id';

    IF v_existing_id IS NULL THEN
      INSERT INTO tracker_contacts (
        group_id, legacy_id, name, org, role, phone, email, notes,
        last_contact, owner_id
      ) VALUES (
        p_group_id, rec->>'legacy_id', rec->>'name',
        NULLIF(rec->>'org',''), NULLIF(rec->>'role',''), NULLIF(rec->>'phone',''),
        NULLIF(rec->>'email',''), NULLIF(rec->>'notes',''),
        NULLIF(rec->>'last_contact','')::date, NULLIF(rec->>'owner_id','')::uuid
      )
      RETURNING id INTO v_id;
      c_con_ins := c_con_ins + 1;
    ELSE
      v_id := v_existing_id;
      UPDATE tracker_contacts SET
        name = rec->>'name',
        org = NULLIF(rec->>'org',''),
        role = NULLIF(rec->>'role',''),
        phone = NULLIF(rec->>'phone',''),
        email = NULLIF(rec->>'email',''),
        notes = NULLIF(rec->>'notes',''),
        last_contact = NULLIF(rec->>'last_contact','')::date,
        owner_id = NULLIF(rec->>'owner_id','')::uuid
      WHERE id = v_id;
      c_con_upd := c_con_upd + 1;
    END IF;
    contact_id_of := contact_id_of || jsonb_build_object(rec->>'legacy_id', v_id::text);
  END LOOP;

  -- ── Milestones: upsert on (plan_id, legacy_id) ────────────────────────────
  FOR rec IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'milestones', '[]'::jsonb)) LOOP
    v_parent := rec->>'plan_legacy_id';
    IF plan_id_of ? v_parent THEN
      v_parent_id := (plan_id_of->>v_parent)::uuid;
    ELSE
      SELECT id INTO v_parent_id FROM tracker_project_plans
        WHERE group_id = p_group_id AND legacy_id = v_parent;
    END IF;
    IF v_parent_id IS NULL THEN
      RAISE EXCEPTION 'Milestone "%" points at a project (%) that does not exist',
        COALESCE(rec->>'title','?'), v_parent;
    END IF;

    SELECT id INTO v_existing_id FROM tracker_milestones
      WHERE plan_id = v_parent_id AND legacy_id = rec->>'legacy_id';

    IF v_existing_id IS NULL THEN
      INSERT INTO tracker_milestones (
        group_id, plan_id, legacy_id, title, description, status, owner_id,
        priority, start_on, due_on, completed_on, progress_pct
      ) VALUES (
        p_group_id, v_parent_id, rec->>'legacy_id', rec->>'title',
        NULLIF(rec->>'description',''),
        COALESCE(NULLIF(rec->>'status',''),'backlog'),
        NULLIF(rec->>'owner_id','')::uuid,
        COALESCE(NULLIF(rec->>'priority',''),'normal')::tracker_priority,
        NULLIF(rec->>'start_on','')::date, NULLIF(rec->>'due_on','')::date,
        NULLIF(rec->>'completed_on','')::date, COALESCE((rec->>'progress_pct')::int, 0)
      )
      RETURNING id INTO v_id;
      c_ms_ins := c_ms_ins + 1;
    ELSE
      v_id := v_existing_id;
      UPDATE tracker_milestones SET
        title = rec->>'title',
        description = NULLIF(rec->>'description',''),
        status = COALESCE(NULLIF(rec->>'status',''),'backlog'),
        owner_id = NULLIF(rec->>'owner_id','')::uuid,
        priority = COALESCE(NULLIF(rec->>'priority',''),'normal')::tracker_priority,
        start_on = NULLIF(rec->>'start_on','')::date,
        due_on = NULLIF(rec->>'due_on','')::date,
        completed_on = NULLIF(rec->>'completed_on','')::date,
        progress_pct = COALESCE((rec->>'progress_pct')::int, 0)
      WHERE id = v_id;
      c_ms_upd := c_ms_upd + 1;
    END IF;
    ms_id_of := ms_id_of || jsonb_build_object(rec->>'legacy_id', v_id::text);
  END LOOP;

  -- ── Actions: upsert on (group_id, legacy_id) ──────────────────────────────
  FOR rec IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'actions', '[]'::jsonb)) LOOP
    -- plan (optional)
    v_parent_id := NULL;
    v_parent := NULLIF(rec->>'plan_legacy_id','');
    IF v_parent IS NOT NULL THEN
      IF plan_id_of ? v_parent THEN
        v_parent_id := (plan_id_of->>v_parent)::uuid;
      ELSE
        SELECT id INTO v_parent_id FROM tracker_project_plans
          WHERE group_id = p_group_id AND legacy_id = v_parent;
      END IF;
      IF v_parent_id IS NULL THEN
        RAISE EXCEPTION 'Action "%" points at a project (%) that does not exist',
          COALESCE(rec->>'title','?'), v_parent;
      END IF;
    END IF;

    -- milestone (optional)
    v_existing_id := NULL;  -- reuse as the milestone uuid holder
    v_parent := NULLIF(rec->>'milestone_legacy_id','');
    IF v_parent IS NOT NULL THEN
      IF ms_id_of ? v_parent THEN
        v_existing_id := (ms_id_of->>v_parent)::uuid;
      ELSE
        SELECT id INTO v_existing_id FROM tracker_milestones
          WHERE group_id = p_group_id AND legacy_id = v_parent;
      END IF;
    END IF;

    -- contact (optional)
    v_region := NULL;  -- reuse as a text holder for the contact uuid
    v_parent := NULLIF(rec->>'contact_legacy_id','');
    IF v_parent IS NOT NULL THEN
      IF contact_id_of ? v_parent THEN
        v_region := contact_id_of->>v_parent;
      ELSE
        SELECT id::text INTO v_region FROM tracker_contacts
          WHERE group_id = p_group_id AND legacy_id = v_parent;
      END IF;
    END IF;

    SELECT id INTO v_id FROM tracker_actions
      WHERE group_id = p_group_id AND legacy_id = rec->>'legacy_id';

    IF v_id IS NULL THEN
      INSERT INTO tracker_actions (
        group_id, legacy_id, plan_id, milestone_id, title, type, who,
        contact_id, assignee_id, due_on, status, priority, notes,
        waiting_since, done_on
      ) VALUES (
        p_group_id, rec->>'legacy_id', v_parent_id, v_existing_id, rec->>'title',
        NULLIF(rec->>'type',''), NULLIF(rec->>'who',''),
        NULLIF(v_region,'')::uuid, NULLIF(rec->>'assignee_id','')::uuid,
        NULLIF(rec->>'due_on','')::date,
        COALESCE(NULLIF(rec->>'status',''),'open')::tracker_action_status,
        COALESCE(NULLIF(rec->>'priority',''),'normal')::tracker_priority,
        NULLIF(rec->>'notes',''), NULLIF(rec->>'waiting_since','')::date,
        NULLIF(rec->>'done_on','')::date
      );
      c_act_ins := c_act_ins + 1;
    ELSE
      UPDATE tracker_actions SET
        plan_id = v_parent_id,
        milestone_id = v_existing_id,
        title = rec->>'title',
        type = NULLIF(rec->>'type',''),
        who = NULLIF(rec->>'who',''),
        contact_id = NULLIF(v_region,'')::uuid,
        assignee_id = NULLIF(rec->>'assignee_id','')::uuid,
        due_on = NULLIF(rec->>'due_on','')::date,
        status = COALESCE(NULLIF(rec->>'status',''),'open')::tracker_action_status,
        priority = COALESCE(NULLIF(rec->>'priority',''),'normal')::tracker_priority,
        notes = NULLIF(rec->>'notes',''),
        waiting_since = NULLIF(rec->>'waiting_since','')::date,
        done_on = NULLIF(rec->>'done_on','')::date
      WHERE id = v_id;
      c_act_upd := c_act_upd + 1;
    END IF;
  END LOOP;

  -- ── Contact → plan links (insert only; never unlinks) ─────────────────────
  FOR rec IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'contact_links', '[]'::jsonb)) LOOP
    v_parent := rec->>'contact_legacy_id';
    IF contact_id_of ? v_parent THEN
      v_existing_id := (contact_id_of->>v_parent)::uuid;
    ELSE
      SELECT id INTO v_existing_id FROM tracker_contacts
        WHERE group_id = p_group_id AND legacy_id = v_parent;
    END IF;

    v_parent := rec->>'plan_legacy_id';
    IF plan_id_of ? v_parent THEN
      v_parent_id := (plan_id_of->>v_parent)::uuid;
    ELSE
      SELECT id INTO v_parent_id FROM tracker_project_plans
        WHERE group_id = p_group_id AND legacy_id = v_parent;
    END IF;

    IF v_existing_id IS NULL OR v_parent_id IS NULL THEN
      CONTINUE;  -- unresolved links are skipped (the translator already noted them)
    END IF;

    INSERT INTO tracker_contact_plans (contact_id, plan_id, group_id)
    VALUES (v_existing_id, v_parent_id, p_group_id)
    ON CONFLICT (contact_id, plan_id) DO NOTHING;
    IF FOUND THEN c_link_ins := c_link_ins + 1; END IF;
  END LOOP;

  -- ── Updates / reviews: upsert on (group_id, legacy_id) ────────────────────
  FOR rec IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'updates', '[]'::jsonb)) LOOP
    v_parent := rec->>'plan_legacy_id';
    IF plan_id_of ? v_parent THEN
      v_parent_id := (plan_id_of->>v_parent)::uuid;
    ELSE
      SELECT id INTO v_parent_id FROM tracker_project_plans
        WHERE group_id = p_group_id AND legacy_id = v_parent;
    END IF;
    IF v_parent_id IS NULL THEN
      RAISE EXCEPTION 'An update points at a project (%) that does not exist', v_parent;
    END IF;

    SELECT id INTO v_id FROM tracker_updates
      WHERE group_id = p_group_id AND legacy_id = rec->>'legacy_id';

    IF v_id IS NULL THEN
      INSERT INTO tracker_updates (
        group_id, plan_id, legacy_id, kind, date, source, text
      ) VALUES (
        p_group_id, v_parent_id, rec->>'legacy_id',
        COALESCE(NULLIF(rec->>'kind',''),'update')::tracker_update_kind,
        COALESCE(NULLIF(rec->>'date','')::date, (v_now AT TIME ZONE 'Australia/Perth')::date),
        NULLIF(rec->>'source',''), rec->>'text'
      );
      c_upd_ins := c_upd_ins + 1;
    ELSE
      UPDATE tracker_updates SET
        plan_id = v_parent_id,
        kind = COALESCE(NULLIF(rec->>'kind',''),'update')::tracker_update_kind,
        date = COALESCE(NULLIF(rec->>'date','')::date, date),
        source = NULLIF(rec->>'source',''),
        text = rec->>'text'
      WHERE id = v_id;
      c_upd_upd := c_upd_upd + 1;
    END IF;
  END LOOP;

  -- Restore the preserve flag to its default for the rest of the session.
  PERFORM set_config('app.tracker_preserve_updated_on', 'off', true);

  -- Record the applied job (its own INSERT policy allows an editor to log it).
  INSERT INTO tracker_import_jobs (group_id, file_name, status, summary, applied_at)
  VALUES (
    p_group_id, p_file_name, 'applied',
    jsonb_build_object(
      'plans',      jsonb_build_object('inserted', c_plans_ins, 'updated', c_plans_upd),
      'milestones', jsonb_build_object('inserted', c_ms_ins,    'updated', c_ms_upd),
      'actions',    jsonb_build_object('inserted', c_act_ins,   'updated', c_act_upd),
      'contacts',   jsonb_build_object('inserted', c_con_ins,   'updated', c_con_upd),
      'contact_links', jsonb_build_object('inserted', c_link_ins),
      'updates',    jsonb_build_object('inserted', c_upd_ins,   'updated', c_upd_upd),
      'regions',    jsonb_build_object('inserted', c_region_ins)
    ),
    v_now
  );

  RETURN jsonb_build_object(
    'plans',      jsonb_build_object('inserted', c_plans_ins, 'updated', c_plans_upd),
    'milestones', jsonb_build_object('inserted', c_ms_ins,    'updated', c_ms_upd),
    'actions',    jsonb_build_object('inserted', c_act_ins,   'updated', c_act_upd),
    'contacts',   jsonb_build_object('inserted', c_con_ins,   'updated', c_con_upd),
    'contact_links', jsonb_build_object('inserted', c_link_ins),
    'updates',    jsonb_build_object('inserted', c_upd_ins,   'updated', c_upd_upd),
    'regions',    jsonb_build_object('inserted', c_region_ins)
  );
END;
$$;

-- Loop detector: raises if any plan in the group reaches itself through its
-- parent chain. Called after the import has wired parents. SECURITY DEFINER so
-- it can walk the whole group's plans regardless of the caller's RLS; it only
-- READS and raises, never writes.
CREATE OR REPLACE FUNCTION tracker_import_check_no_cycles(p_group_id uuid)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bad text;
BEGIN
  WITH RECURSIVE chain(root, id, depth) AS (
    SELECT p.id, p.id, 0
    FROM tracker_project_plans p
    WHERE p.group_id = p_group_id AND p.parent_id IS NOT NULL
    UNION ALL
    SELECT c.root, p.parent_id, c.depth + 1
    FROM chain c
    JOIN tracker_project_plans p ON p.id = c.id
    WHERE p.parent_id IS NOT NULL AND c.depth < 100
  )
  SELECT string_agg(DISTINCT pl.name, ', ')
  INTO v_bad
  FROM chain c
  JOIN tracker_project_plans pl ON pl.id = c.root
  WHERE c.id = c.root AND c.depth > 0;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Projects form a parent loop (through %)', v_bad;
  END IF;
END;
$$;
