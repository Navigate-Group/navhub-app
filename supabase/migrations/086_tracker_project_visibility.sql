-- Migration 086: Tracker project visibility (projects are need-to-know)
-- ──────────────────────────────────────────────────────────────────────────
-- Until now every member of a group could read every project. From here:
--
--   Managers and Group Owners   see every project in the group (unchanged).
--   Everyone else               sees a project only when they are its Lead, in
--                               its Members list, or given Comment / Edit on
--                               the Project access page (082) — on the project
--                               itself or on any parent, so access to a parent
--                               covers its sub-projects (as access already did).
--   An action's assignee        sees that action (in My week) even without
--                               seeing its project, and can still update its
--                               status and due date (082 guard, unchanged).
--   Contacts                    are visible to editors, to the person who added
--                               them, and to anyone who can see a project they
--                               are linked to or who is assigned an action with
--                               them.
--
-- What people may CHANGE is unchanged (082): Edit / Comment access, the
-- assignee's quick changes, editor-only settings, lists, deletes and archive.
-- Only reading is narrowed. The views in 083 are security_invoker, so they
-- follow these rules automatically.
--
-- Requires migrations 079–085. Only tracker_* objects are touched. Safe to re-run.

-- ── 1. "view" now means lead / member / project access (or an editor) ───────
CREATE OR REPLACE FUNCTION tracker_can_access(p_plan_id uuid, p_level text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id uuid;
  v_role     text;
  v_chain    uuid[];
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
  IF v_role IN ('manager', 'group_owner') THEN
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
  SELECT array_agg(id) INTO v_chain FROM chain;

  IF p_level = 'view' THEN
    RETURN EXISTS (SELECT 1 FROM tracker_project_plans p
                   WHERE p.id = ANY (v_chain)
                     AND (p.lead_id = auth.uid() OR p.owner_id = auth.uid()))
        OR EXISTS (SELECT 1 FROM tracker_plan_members m
                   WHERE m.plan_id = ANY (v_chain) AND m.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM tracker_plan_shares s
                   WHERE s.plan_id = ANY (v_chain) AND s.user_id = auth.uid());
  END IF;

  SELECT max(CASE s.level WHEN 'edit' THEN 2 WHEN 'comment' THEN 1 ELSE 0 END)
  INTO v_rank
  FROM tracker_plan_shares s
  WHERE s.plan_id = ANY (v_chain) AND s.user_id = auth.uid();

  RETURN COALESCE(v_rank, 0) >= CASE p_level WHEN 'edit' THEN 2 ELSE 1 END;
END;
$$;

-- ── 2. Who can see a contact ────────────────────────────────────────────────
-- created_by is passed in (not looked up) so a contact someone has just added
-- passes the check on INSERT … RETURNING, before the row is visible to lookups.
DROP FUNCTION IF EXISTS tracker_can_see_contact(uuid, uuid);
CREATE OR REPLACE FUNCTION tracker_can_see_contact(p_contact_id uuid, p_group_id uuid, p_created_by uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT tracker_is_editor(p_group_id)
      OR (tracker_is_group_member(p_group_id)
          AND (p_created_by = auth.uid()
               OR EXISTS (SELECT 1 FROM tracker_contact_plans cp
                          WHERE cp.contact_id = p_contact_id
                            AND tracker_can_access(cp.plan_id, 'view'))
               OR EXISTS (SELECT 1 FROM tracker_actions a
                          WHERE a.contact_id = p_contact_id
                            AND a.assignee_id = auth.uid()
                            AND a.archived_at IS NULL)))
$$;

-- ── 3. Names of the projects behind my own actions ──────────────────────────
-- So My week can show "which project" for an action assigned to someone who
-- can't see that project. Returns only id and name, only for projects where the
-- signed-in person is assigned a live action, and only in groups they belong to.
CREATE OR REPLACE FUNCTION tracker_my_action_plans(p_group_id uuid)
RETURNS TABLE (id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT p.id, p.name
  FROM tracker_actions a
  JOIN tracker_project_plans p ON p.id = a.plan_id
  WHERE a.group_id = p_group_id
    AND a.assignee_id = auth.uid()
    AND a.archived_at IS NULL
    AND tracker_is_group_member(p_group_id)
$$;
REVOKE ALL ON FUNCTION tracker_my_action_plans(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracker_my_action_plans(uuid) TO authenticated;

-- ── 4. Read policies ────────────────────────────────────────────────────────
-- The editor check uses the row's own group_id first, so a project a Manager has
-- just created passes on INSERT … RETURNING (it isn't visible to lookups yet).
DROP POLICY IF EXISTS tracker_project_plans_select ON tracker_project_plans;
CREATE POLICY tracker_project_plans_select ON tracker_project_plans FOR SELECT TO authenticated
  USING (tracker_is_editor(group_id) OR tracker_can_access(id, 'view'));

DROP POLICY IF EXISTS tracker_milestones_select ON tracker_milestones;
CREATE POLICY tracker_milestones_select ON tracker_milestones FOR SELECT TO authenticated
  USING (tracker_can_access(plan_id, 'view'));

DROP POLICY IF EXISTS tracker_updates_select ON tracker_updates;
CREATE POLICY tracker_updates_select ON tracker_updates FOR SELECT TO authenticated
  USING (tracker_can_access(plan_id, 'view'));

DROP POLICY IF EXISTS tracker_comments_select ON tracker_comments;
CREATE POLICY tracker_comments_select ON tracker_comments FOR SELECT TO authenticated
  USING (tracker_can_access(plan_id, 'view'));

DROP POLICY IF EXISTS tracker_actions_select ON tracker_actions;
CREATE POLICY tracker_actions_select ON tracker_actions FOR SELECT TO authenticated
  USING (
    (assignee_id = (SELECT auth.uid()) AND tracker_is_group_member(group_id))
    OR (plan_id IS NULL AND tracker_is_editor(group_id))
    OR (plan_id IS NOT NULL AND tracker_can_access(plan_id, 'view'))
  );

DROP POLICY IF EXISTS tracker_contacts_select ON tracker_contacts;
CREATE POLICY tracker_contacts_select ON tracker_contacts FOR SELECT TO authenticated
  USING (tracker_can_see_contact(id, group_id, created_by));

DROP POLICY IF EXISTS tracker_contact_plans_select ON tracker_contact_plans;
CREATE POLICY tracker_contact_plans_select ON tracker_contact_plans FOR SELECT TO authenticated
  USING (tracker_can_access(plan_id, 'view'));

DROP POLICY IF EXISTS tracker_activity_log_select ON tracker_activity_log;
CREATE POLICY tracker_activity_log_select ON tracker_activity_log FOR SELECT TO authenticated
  USING (tracker_is_editor(group_id)
         OR (plan_id IS NOT NULL AND tracker_can_access(plan_id, 'view')));
