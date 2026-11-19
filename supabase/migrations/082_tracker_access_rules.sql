-- Migration 082: Tracker access rules (P2)
-- ──────────────────────────────────────────────────────────────────────────
-- Row-level security policies and guards for all 14 tracker_* tables.
--
-- Base access comes from the person's NavHub role in the group
-- (user_groups.role, never copied into tracker tables):
--   • every member of the group reads all its projects;
--   • manager and group_owner ("editors") edit everything;
--   • a Manager / Group Owner can give any other member of the group project
--     access (tracker_plan_shares: comment or edit). Access to a project
--     includes all its sub-projects (not the other way round); without it,
--     every other role (staff, group_admin, super_admin, viewer, …) reads only.
-- Extras: an action's assignee may change its status and due date; only the
-- plan's owner (an editor) deletes a plan permanently; weekly reviews are
-- private; the activity log is read-only for everyone.
--
-- Requires migrations 079–081. Only tracker_* objects are touched. Safe to
-- re-run.

-- ── 1. Who someone is in a group ────────────────────────────────────────────
-- All helpers are SECURITY DEFINER with a fixed search_path so they can read
-- user_groups / tracker tables regardless of the caller's own RLS.

-- Internal: any user's role in a group. Not callable by app users (it would
-- reveal other people's roles); the helpers below call it as the owner.
CREATE OR REPLACE FUNCTION tracker_member_role(p_group_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT ug.role::text
  FROM user_groups ug
  WHERE ug.group_id = p_group_id AND ug.user_id = p_user_id
$$;
REVOKE EXECUTE ON FUNCTION tracker_member_role(uuid, uuid) FROM PUBLIC;
DO $$ BEGIN
  REVOKE EXECUTE ON FUNCTION tracker_member_role(uuid, uuid) FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- True for any role in the group.
CREATE OR REPLACE FUNCTION tracker_is_group_member(p_group_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT tracker_member_role(p_group_id, auth.uid()) IS NOT NULL
$$;

-- True when the signed-in user is a manager or group_owner of the group.
CREATE OR REPLACE FUNCTION tracker_is_editor(p_group_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(tracker_member_role(p_group_id, auth.uid()) IN ('manager', 'group_owner'), false)
$$;

-- ── 2. The access rule ──────────────────────────────────────────────────────
-- view:    any member of the plan's group
-- comment: an editor, or a member with project access comment / edit
-- edit:    an editor, or a member with project access edit
-- Project access on a plan or on any of its parents counts (the highest wins).
CREATE OR REPLACE FUNCTION tracker_can_access(p_plan_id uuid, p_level text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id uuid;
  v_role     text;
  v_rank     int;
BEGIN
  IF p_level NOT IN ('view', 'comment', 'edit') THEN
    RAISE EXCEPTION 'tracker_can_access: unknown level %', p_level;
  END IF;

  SELECT p.group_id INTO v_group_id FROM tracker_project_plans p WHERE p.id = p_plan_id;
  IF v_group_id IS NULL THEN
    RETURN false;
  END IF;

  v_role := tracker_member_role(v_group_id, auth.uid());
  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  IF p_level = 'view' OR v_role IN ('manager', 'group_owner') THEN
    RETURN true;
  END IF;

  -- The plan and its parents (parents are always in the same group; depth
  -- capped as a safety net).
  WITH RECURSIVE chain(id, depth) AS (
    SELECT p_plan_id, 0
    UNION ALL
    SELECT p.parent_id, c.depth + 1
    FROM tracker_project_plans p
    JOIN chain c ON p.id = c.id
    WHERE p.parent_id IS NOT NULL AND c.depth < 20
  )
  SELECT max(CASE s.level WHEN 'edit' THEN 2 WHEN 'comment' THEN 1 ELSE 0 END)
  INTO v_rank
  FROM tracker_plan_shares s
  JOIN chain c ON c.id = s.plan_id
  WHERE s.user_id = auth.uid();

  RETURN COALESCE(v_rank, 0) >= CASE p_level WHEN 'edit' THEN 2 ELSE 1 END;
END;
$$;

-- Editor of the group that owns a plan (for project access / plan members).
CREATE OR REPLACE FUNCTION tracker_is_plan_editor(p_plan_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((SELECT tracker_is_editor(p.group_id)
                   FROM tracker_project_plans p WHERE p.id = p_plan_id), false)
$$;

-- Full edit on an action: edit on its plan, or an editor for a plan-less action.
CREATE OR REPLACE FUNCTION tracker_action_can_edit(p_plan_id uuid, p_group_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_plan_id IS NULL THEN tracker_is_editor(p_group_id)
              ELSE tracker_can_access(p_plan_id, 'edit') END
$$;

-- Add a contact: an editor, or a member with edit access on any plan in the group.
CREATE OR REPLACE FUNCTION tracker_can_add_contact(p_group_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT tracker_is_editor(p_group_id)
      OR (tracker_is_group_member(p_group_id)
          AND EXISTS (SELECT 1
                      FROM tracker_plan_shares s
                      JOIN tracker_project_plans p ON p.id = s.plan_id
                      WHERE p.group_id = p_group_id
                        AND s.user_id = auth.uid()
                        AND s.level = 'edit'))
$$;

-- Change a contact: an editor, or edit access on a plan the contact is linked to.
CREATE OR REPLACE FUNCTION tracker_contact_can_edit(p_contact_id uuid, p_group_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT tracker_is_editor(p_group_id)
      OR EXISTS (SELECT 1 FROM tracker_contact_plans cp
                 WHERE cp.contact_id = p_contact_id
                   AND tracker_can_access(cp.plan_id, 'edit'))
$$;

-- A comment's item must belong to the comment's plan.
CREATE OR REPLACE FUNCTION tracker_comment_target_ok(p_plan_id uuid, p_entity_type text, p_entity_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE p_entity_type
    WHEN 'plan'      THEN p_entity_id = p_plan_id
    WHEN 'milestone' THEN EXISTS (SELECT 1 FROM tracker_milestones m
                                  WHERE m.id = p_entity_id AND m.plan_id = p_plan_id)
    WHEN 'action'    THEN EXISTS (SELECT 1 FROM tracker_actions a
                                  WHERE a.id = p_entity_id AND a.plan_id = p_plan_id)
    ELSE false
  END
$$;

-- ── 3. tracker_init_group: editors only (agreed starting lists unchanged) ──
-- Called by the app when a group's tracker is first opened. A non-editor
-- calling it on an already set-up group is a no-op; on a new group it is
-- refused. Migrations / service calls (no signed-in user) are always allowed.
CREATE OR REPLACE FUNCTION tracker_init_group(p_group_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT tracker_is_editor(p_group_id) THEN
    IF EXISTS (SELECT 1 FROM tracker_settings s WHERE s.group_id = p_group_id) THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'Only a Manager or Group Owner can set up the tracker for this group'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO tracker_settings (group_id)
  VALUES (p_group_id)
  ON CONFLICT (group_id) DO NOTHING;

  INSERT INTO tracker_lookups (group_id, list, key, label, sort_order)
  VALUES
    (p_group_id, 'category', 'product_software',      'Product & software',      0),
    (p_group_id, 'category', 'data_science_ci',       'Data science & CI',       1),
    (p_group_id, 'category', 'partners_field_trials', 'Partners & field trials', 2),
    (p_group_id, 'category', 'proposals_pipeline',    'Proposals & pipeline',    3),
    (p_group_id, 'category', 'grants',                'Grants',                  4),
    (p_group_id, 'status', 'on_track',              'On track',                0),
    (p_group_id, 'status', 'at_risk',               'At risk',                 1),
    (p_group_id, 'status', 'blocked',               'Blocked',                 2),
    (p_group_id, 'status', 'waiting_on_others',     'Waiting on others',       3),
    (p_group_id, 'status', 'proposal_pre_contract', 'Proposal / pre-contract', 4),
    (p_group_id, 'status', 'wrapping_up',           'Wrapping up',             5),
    (p_group_id, 'status', 'needs_status_check',    'Needs a status check',    6),
    (p_group_id, 'status', 'finished',              'Finished',                7),
    (p_group_id, 'milestone_status', 'backlog',     'Backlog',     0),
    (p_group_id, 'milestone_status', 'planned',     'Planned',     1),
    (p_group_id, 'milestone_status', 'in_progress', 'In progress', 2),
    (p_group_id, 'milestone_status', 'at_risk',     'At risk',     3),
    (p_group_id, 'milestone_status', 'blocked',     'Blocked',     4),
    (p_group_id, 'milestone_status', 'completed',   'Completed',   5),
    (p_group_id, 'milestone_status', 'cancelled',   'Cancelled',   6),
    (p_group_id, 'action_type', 'do',      'Do',      0),
    (p_group_id, 'action_type', 'call',    'Call',    1),
    (p_group_id, 'action_type', 'email',   'Email',   2),
    (p_group_id, 'action_type', 'chase',   'Chase',   3),
    (p_group_id, 'action_type', 'decide',  'Decide',  4),
    (p_group_id, 'action_type', 'meeting', 'Meeting', 5),
    (p_group_id, 'source', 'my_note',     'My note',       0),
    (p_group_id, 'source', 'email',       'Email',         1),
    (p_group_id, 'source', 'screenshot',  'Screenshot',    2),
    (p_group_id, 'source', 'meeting',     'Meeting',       3),
    (p_group_id, 'source', 'file_folder', 'File / folder', 4),
    (p_group_id, 'source', 'call',        'Call',          5),
    (p_group_id, 'review_step', 'clear_inbox',           'Clear inbox',               0),
    (p_group_id, 'review_step', 'next_action_each_plan', 'Next action for each plan', 1),
    (p_group_id, 'review_step', 'chase_waiting',         'Chase waiting',             2),
    (p_group_id, 'review_step', 'refresh_status',        'Refresh status',            3),
    (p_group_id, 'review_step', 'look_ahead',            'Look ahead',                4),
    (p_group_id, 'review_step', 'book_calls',            'Book calls',                5),
    (p_group_id, 'review_step', 'pick_top_three',        'Pick top three',            6)
    -- region: starts empty
  ON CONFLICT (group_id, list, key) DO NOTHING;
END;
$$;

-- ── 4. System triggers run as the owner ─────────────────────────────────────
-- The activity log has no write policy, so its trigger must bypass RLS to
-- record changes made by signed-in users. The "update moves the plan's
-- last-updated date" trigger is bookkeeping and must work for anyone allowed
-- to log an update. auth.uid() still returns the signed-in user inside them.
ALTER FUNCTION tracker_activity_log_fn() SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION tracker_update_moves_plan_updated_on() SECURITY DEFINER SET search_path = public, pg_temp;

-- ── 5. Guards (column-level rules RLS cannot express) ───────────────────────
-- Guards apply only to signed-in users; migrations, the service role and
-- system jobs (auth.uid() IS NULL) are not restricted. Refusals use SQLSTATE
-- 42501 (insufficient_privilege), the same as an RLS refusal.

-- Plans: no moving groups; owner and archive/restore are editor-only; the
-- owner must be an editor of the group; the lead must be a group member.
CREATE OR REPLACE FUNCTION tracker_plan_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.group_id IS DISTINCT FROM OLD.group_id THEN
      RAISE EXCEPTION 'A plan cannot be moved to another group' USING ERRCODE = '42501';
    END IF;
    IF NEW.owner_id IS DISTINCT FROM OLD.owner_id AND NOT tracker_is_editor(NEW.group_id) THEN
      RAISE EXCEPTION 'Only a Manager or Group Owner can change a plan''s owner' USING ERRCODE = '42501';
    END IF;
    IF NEW.archived_at IS DISTINCT FROM OLD.archived_at AND NOT tracker_is_editor(NEW.group_id) THEN
      RAISE EXCEPTION 'Only a Manager or Group Owner can archive or restore a plan' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF (TG_OP = 'INSERT' OR NEW.owner_id IS DISTINCT FROM OLD.owner_id)
     AND NOT COALESCE(tracker_member_role(NEW.group_id, NEW.owner_id) IN ('manager', 'group_owner'), false) THEN
    RAISE EXCEPTION 'A plan''s owner must be a Manager or Group Owner of the group' USING ERRCODE = '42501';
  END IF;

  IF NEW.lead_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.lead_id IS DISTINCT FROM OLD.lead_id)
     AND tracker_member_role(NEW.group_id, NEW.lead_id) IS NULL THEN
    RAISE EXCEPTION 'A plan''s lead must be a member of the group' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tracker_plan_guard ON tracker_project_plans;
CREATE TRIGGER trg_tracker_plan_guard
  BEFORE INSERT OR UPDATE ON tracker_project_plans
  FOR EACH ROW EXECUTE FUNCTION tracker_plan_guard();

-- Actions: the assignee must be a group member; without edit access, the
-- assignee may change only status, due date, waiting-since and done-on.
CREATE OR REPLACE FUNCTION tracker_action_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_allowed text[] := ARRAY['status', 'due_on', 'waiting_since', 'done_on', 'updated_by', 'updated_at'];
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.assignee_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id)
     AND tracker_member_role(NEW.group_id, NEW.assignee_id) IS NULL THEN
    RAISE EXCEPTION 'An action''s assignee must be a member of the group' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND NOT tracker_action_can_edit(OLD.plan_id, OLD.group_id) THEN
    IF OLD.assignee_id IS DISTINCT FROM auth.uid()
       OR (to_jsonb(NEW) - v_allowed) IS DISTINCT FROM (to_jsonb(OLD) - v_allowed) THEN
      RAISE EXCEPTION 'Without edit access you can only change the status and due date of an action assigned to you'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tracker_action_guard ON tracker_actions;
CREATE TRIGGER trg_tracker_action_guard
  BEFORE INSERT OR UPDATE ON tracker_actions
  FOR EACH ROW EXECUTE FUNCTION tracker_action_guard();

-- Comments: the item must belong to the plan; the author is the signed-in
-- person; authors edit their own text; editors may only remove (deleted_at)
-- other people's comments.
CREATE OR REPLACE FUNCTION tracker_comment_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT tracker_comment_target_ok(NEW.plan_id, NEW.entity_type, NEW.entity_id) THEN
    RAISE EXCEPTION 'A comment''s item must belong to the comment''s plan' USING ERRCODE = '23514';
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.author_id := COALESCE(NEW.author_id, auth.uid());
    IF NEW.author_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'A comment''s author must be the signed-in person' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.group_id, NEW.plan_id, NEW.entity_type, NEW.entity_id, NEW.author_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.group_id, OLD.plan_id, OLD.entity_type, OLD.entity_id, OLD.author_id, OLD.created_at) THEN
    RAISE EXCEPTION 'Only a comment''s text can be changed' USING ERRCODE = '42501';
  END IF;

  IF OLD.author_id IS DISTINCT FROM auth.uid() THEN
    IF (to_jsonb(NEW) - 'deleted_at') IS DISTINCT FROM (to_jsonb(OLD) - 'deleted_at') THEN
      RAISE EXCEPTION 'You can only remove other people''s comments, not edit them' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.body IS DISTINCT FROM OLD.body THEN
    NEW.edited_at := now();
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tracker_comment_guard ON tracker_comments;
CREATE TRIGGER trg_tracker_comment_guard
  BEFORE INSERT OR UPDATE ON tracker_comments
  FOR EACH ROW EXECUTE FUNCTION tracker_comment_guard();

-- Project access: for any member of the plan's group who is not already a
-- Manager / Group Owner, at comment or edit; only the level can change;
-- shared_by records who gave it.
CREATE OR REPLACE FUNCTION tracker_share_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id uuid;
  v_role     text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    RAISE EXCEPTION 'Only the project access level can be changed' USING ERRCODE = '42501';
  END IF;

  SELECT p.group_id INTO v_group_id FROM tracker_project_plans p WHERE p.id = NEW.plan_id;
  v_role := tracker_member_role(v_group_id, NEW.user_id);

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Project access can only be given to a member of the group' USING ERRCODE = '42501';
  END IF;
  IF v_role IN ('manager', 'group_owner') THEN
    RAISE EXCEPTION 'Managers and Group Owners already have full access' USING ERRCODE = '42501';
  END IF;
  IF NEW.level NOT IN ('comment', 'edit') THEN
    RAISE EXCEPTION 'Project access is Comment or Edit' USING ERRCODE = '42501';
  END IF;

  NEW.shared_by := auth.uid();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tracker_share_guard ON tracker_plan_shares;
CREATE TRIGGER trg_tracker_share_guard
  BEFORE INSERT OR UPDATE ON tracker_plan_shares
  FOR EACH ROW EXECUTE FUNCTION tracker_share_guard();

-- Plan members: the person must be a member of the plan's group.
CREATE OR REPLACE FUNCTION tracker_plan_member_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.group_id INTO v_group_id FROM tracker_project_plans p WHERE p.id = NEW.plan_id;
  IF tracker_member_role(v_group_id, NEW.user_id) IS NULL THEN
    RAISE EXCEPTION 'A plan member must be a member of the group' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tracker_plan_member_guard ON tracker_plan_members;
CREATE TRIGGER trg_tracker_plan_member_guard
  BEFORE INSERT OR UPDATE ON tracker_plan_members
  FOR EACH ROW EXECUTE FUNCTION tracker_plan_member_guard();

-- ── 6. Row-level security policies ──────────────────────────────────────────
-- RLS is already enabled on all 14 tables (079). Policies apply to the
-- authenticated role only, so anon sees nothing. Re-runnable: each policy is
-- dropped and re-created.

-- tracker_settings: members read; editors create and change.
DROP POLICY IF EXISTS tracker_settings_select ON tracker_settings;
CREATE POLICY tracker_settings_select ON tracker_settings FOR SELECT TO authenticated
  USING (tracker_is_group_member(group_id));
DROP POLICY IF EXISTS tracker_settings_insert ON tracker_settings;
CREATE POLICY tracker_settings_insert ON tracker_settings FOR INSERT TO authenticated
  WITH CHECK (tracker_is_editor(group_id));
DROP POLICY IF EXISTS tracker_settings_update ON tracker_settings;
CREATE POLICY tracker_settings_update ON tracker_settings FOR UPDATE TO authenticated
  USING (tracker_is_editor(group_id)) WITH CHECK (tracker_is_editor(group_id));

-- tracker_lookups: members read; editors add and change (hide with active = false).
DROP POLICY IF EXISTS tracker_lookups_select ON tracker_lookups;
CREATE POLICY tracker_lookups_select ON tracker_lookups FOR SELECT TO authenticated
  USING (tracker_is_group_member(group_id));
DROP POLICY IF EXISTS tracker_lookups_insert ON tracker_lookups;
CREATE POLICY tracker_lookups_insert ON tracker_lookups FOR INSERT TO authenticated
  WITH CHECK (tracker_is_editor(group_id));
DROP POLICY IF EXISTS tracker_lookups_update ON tracker_lookups;
CREATE POLICY tracker_lookups_update ON tracker_lookups FOR UPDATE TO authenticated
  USING (tracker_is_editor(group_id)) WITH CHECK (tracker_is_editor(group_id));

-- tracker_project_plans: members read; editors create; edit access changes
-- fields (owner and archive are editor-only, see guard); only the owner, who
-- must be an editor, deletes permanently.
DROP POLICY IF EXISTS tracker_project_plans_select ON tracker_project_plans;
CREATE POLICY tracker_project_plans_select ON tracker_project_plans FOR SELECT TO authenticated
  USING (tracker_is_group_member(group_id));
DROP POLICY IF EXISTS tracker_project_plans_insert ON tracker_project_plans;
CREATE POLICY tracker_project_plans_insert ON tracker_project_plans FOR INSERT TO authenticated
  WITH CHECK (tracker_is_editor(group_id));
DROP POLICY IF EXISTS tracker_project_plans_update ON tracker_project_plans;
CREATE POLICY tracker_project_plans_update ON tracker_project_plans FOR UPDATE TO authenticated
  USING (tracker_can_access(id, 'edit')) WITH CHECK (tracker_can_access(id, 'edit'));
DROP POLICY IF EXISTS tracker_project_plans_delete ON tracker_project_plans;
CREATE POLICY tracker_project_plans_delete ON tracker_project_plans FOR DELETE TO authenticated
  USING (owner_id = (SELECT auth.uid()) AND tracker_is_editor(group_id));

-- tracker_plan_members and tracker_plan_shares: members read; editors write.
DROP POLICY IF EXISTS tracker_plan_members_select ON tracker_plan_members;
CREATE POLICY tracker_plan_members_select ON tracker_plan_members FOR SELECT TO authenticated
  USING (tracker_can_access(plan_id, 'view'));
DROP POLICY IF EXISTS tracker_plan_members_insert ON tracker_plan_members;
CREATE POLICY tracker_plan_members_insert ON tracker_plan_members FOR INSERT TO authenticated
  WITH CHECK (tracker_is_plan_editor(plan_id));
DROP POLICY IF EXISTS tracker_plan_members_update ON tracker_plan_members;
CREATE POLICY tracker_plan_members_update ON tracker_plan_members FOR UPDATE TO authenticated
  USING (tracker_is_plan_editor(plan_id)) WITH CHECK (tracker_is_plan_editor(plan_id));
DROP POLICY IF EXISTS tracker_plan_members_delete ON tracker_plan_members;
CREATE POLICY tracker_plan_members_delete ON tracker_plan_members FOR DELETE TO authenticated
  USING (tracker_is_plan_editor(plan_id));

DROP POLICY IF EXISTS tracker_plan_shares_select ON tracker_plan_shares;
CREATE POLICY tracker_plan_shares_select ON tracker_plan_shares FOR SELECT TO authenticated
  USING (tracker_can_access(plan_id, 'view'));
DROP POLICY IF EXISTS tracker_plan_shares_insert ON tracker_plan_shares;
CREATE POLICY tracker_plan_shares_insert ON tracker_plan_shares FOR INSERT TO authenticated
  WITH CHECK (tracker_is_plan_editor(plan_id));
DROP POLICY IF EXISTS tracker_plan_shares_update ON tracker_plan_shares;
CREATE POLICY tracker_plan_shares_update ON tracker_plan_shares FOR UPDATE TO authenticated
  USING (tracker_is_plan_editor(plan_id)) WITH CHECK (tracker_is_plan_editor(plan_id));
DROP POLICY IF EXISTS tracker_plan_shares_delete ON tracker_plan_shares;
CREATE POLICY tracker_plan_shares_delete ON tracker_plan_shares FOR DELETE TO authenticated
  USING (tracker_is_plan_editor(plan_id));

-- tracker_milestones and tracker_updates: members read; edit access on the
-- plan adds and changes; editors delete.
DROP POLICY IF EXISTS tracker_milestones_select ON tracker_milestones;
CREATE POLICY tracker_milestones_select ON tracker_milestones FOR SELECT TO authenticated
  USING (tracker_is_group_member(group_id));
DROP POLICY IF EXISTS tracker_milestones_insert ON tracker_milestones;
CREATE POLICY tracker_milestones_insert ON tracker_milestones FOR INSERT TO authenticated
  WITH CHECK (tracker_can_access(plan_id, 'edit'));
DROP POLICY IF EXISTS tracker_milestones_update ON tracker_milestones;
CREATE POLICY tracker_milestones_update ON tracker_milestones FOR UPDATE TO authenticated
  USING (tracker_can_access(plan_id, 'edit')) WITH CHECK (tracker_can_access(plan_id, 'edit'));
DROP POLICY IF EXISTS tracker_milestones_delete ON tracker_milestones;
CREATE POLICY tracker_milestones_delete ON tracker_milestones FOR DELETE TO authenticated
  USING (tracker_is_editor(group_id));

DROP POLICY IF EXISTS tracker_updates_select ON tracker_updates;
CREATE POLICY tracker_updates_select ON tracker_updates FOR SELECT TO authenticated
  USING (tracker_is_group_member(group_id));
DROP POLICY IF EXISTS tracker_updates_insert ON tracker_updates;
CREATE POLICY tracker_updates_insert ON tracker_updates FOR INSERT TO authenticated
  WITH CHECK (tracker_can_access(plan_id, 'edit'));
DROP POLICY IF EXISTS tracker_updates_update ON tracker_updates;
CREATE POLICY tracker_updates_update ON tracker_updates FOR UPDATE TO authenticated
  USING (tracker_can_access(plan_id, 'edit')) WITH CHECK (tracker_can_access(plan_id, 'edit'));
DROP POLICY IF EXISTS tracker_updates_delete ON tracker_updates;
CREATE POLICY tracker_updates_delete ON tracker_updates FOR DELETE TO authenticated
  USING (tracker_is_editor(group_id));

-- tracker_actions: members read; edit access on the plan (editors for a
-- plan-less action) adds and changes; the assignee may also change status and
-- due date (column limits in the guard); editors delete.
DROP POLICY IF EXISTS tracker_actions_select ON tracker_actions;
CREATE POLICY tracker_actions_select ON tracker_actions FOR SELECT TO authenticated
  USING (tracker_is_group_member(group_id));
DROP POLICY IF EXISTS tracker_actions_insert ON tracker_actions;
CREATE POLICY tracker_actions_insert ON tracker_actions FOR INSERT TO authenticated
  WITH CHECK (tracker_action_can_edit(plan_id, group_id));
DROP POLICY IF EXISTS tracker_actions_update ON tracker_actions;
CREATE POLICY tracker_actions_update ON tracker_actions FOR UPDATE TO authenticated
  USING (tracker_action_can_edit(plan_id, group_id)
         OR (assignee_id = (SELECT auth.uid()) AND tracker_is_group_member(group_id)))
  WITH CHECK (tracker_action_can_edit(plan_id, group_id)
             OR (assignee_id = (SELECT auth.uid()) AND tracker_is_group_member(group_id)));
DROP POLICY IF EXISTS tracker_actions_delete ON tracker_actions;
CREATE POLICY tracker_actions_delete ON tracker_actions FOR DELETE TO authenticated
  USING (tracker_is_editor(group_id));

-- tracker_contacts: members read; editors, or members with edit access, add;
-- editors or edit access on a linked plan change; editors delete.
DROP POLICY IF EXISTS tracker_contacts_select ON tracker_contacts;
CREATE POLICY tracker_contacts_select ON tracker_contacts FOR SELECT TO authenticated
  USING (tracker_is_group_member(group_id));
DROP POLICY IF EXISTS tracker_contacts_insert ON tracker_contacts;
CREATE POLICY tracker_contacts_insert ON tracker_contacts FOR INSERT TO authenticated
  WITH CHECK (tracker_can_add_contact(group_id));
DROP POLICY IF EXISTS tracker_contacts_update ON tracker_contacts;
CREATE POLICY tracker_contacts_update ON tracker_contacts FOR UPDATE TO authenticated
  USING (tracker_contact_can_edit(id, group_id)) WITH CHECK (tracker_contact_can_edit(id, group_id));
DROP POLICY IF EXISTS tracker_contacts_delete ON tracker_contacts;
CREATE POLICY tracker_contacts_delete ON tracker_contacts FOR DELETE TO authenticated
  USING (tracker_is_editor(group_id));

-- tracker_contact_plans: members read; edit access on the plan links / unlinks.
DROP POLICY IF EXISTS tracker_contact_plans_select ON tracker_contact_plans;
CREATE POLICY tracker_contact_plans_select ON tracker_contact_plans FOR SELECT TO authenticated
  USING (tracker_is_group_member(group_id));
DROP POLICY IF EXISTS tracker_contact_plans_insert ON tracker_contact_plans;
CREATE POLICY tracker_contact_plans_insert ON tracker_contact_plans FOR INSERT TO authenticated
  WITH CHECK (tracker_can_access(plan_id, 'edit'));
DROP POLICY IF EXISTS tracker_contact_plans_delete ON tracker_contact_plans;
CREATE POLICY tracker_contact_plans_delete ON tracker_contact_plans FOR DELETE TO authenticated
  USING (tracker_can_access(plan_id, 'edit'));

-- tracker_comments: members read; comment access posts (as themselves);
-- authors edit and delete their own while they keep comment access; editors
-- remove any (the guard limits editors to deleted_at on others' comments).
DROP POLICY IF EXISTS tracker_comments_select ON tracker_comments;
CREATE POLICY tracker_comments_select ON tracker_comments FOR SELECT TO authenticated
  USING (tracker_is_group_member(group_id));
DROP POLICY IF EXISTS tracker_comments_insert ON tracker_comments;
CREATE POLICY tracker_comments_insert ON tracker_comments FOR INSERT TO authenticated
  WITH CHECK (tracker_can_access(plan_id, 'comment') AND author_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS tracker_comments_update ON tracker_comments;
CREATE POLICY tracker_comments_update ON tracker_comments FOR UPDATE TO authenticated
  USING ((author_id = (SELECT auth.uid()) AND tracker_can_access(plan_id, 'comment'))
         OR tracker_is_editor(group_id))
  WITH CHECK ((author_id = (SELECT auth.uid()) AND tracker_can_access(plan_id, 'comment'))
             OR tracker_is_editor(group_id));
DROP POLICY IF EXISTS tracker_comments_delete ON tracker_comments;
CREATE POLICY tracker_comments_delete ON tracker_comments FOR DELETE TO authenticated
  USING ((author_id = (SELECT auth.uid()) AND tracker_can_access(plan_id, 'comment'))
         OR tracker_is_editor(group_id));

-- tracker_reviews: each person reads and writes only their own.
DROP POLICY IF EXISTS tracker_reviews_own ON tracker_reviews;
CREATE POLICY tracker_reviews_own ON tracker_reviews FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()) AND tracker_is_group_member(group_id))
  WITH CHECK (user_id = (SELECT auth.uid()) AND tracker_is_group_member(group_id));

-- tracker_activity_log: members read; nobody writes (the trigger runs as owner).
DROP POLICY IF EXISTS tracker_activity_log_select ON tracker_activity_log;
CREATE POLICY tracker_activity_log_select ON tracker_activity_log FOR SELECT TO authenticated
  USING (tracker_is_group_member(group_id));

-- tracker_import_jobs: editors read; written only by the import functions (P4).
DROP POLICY IF EXISTS tracker_import_jobs_select ON tracker_import_jobs;
CREATE POLICY tracker_import_jobs_select ON tracker_import_jobs FOR SELECT TO authenticated
  USING (tracker_is_editor(group_id));
