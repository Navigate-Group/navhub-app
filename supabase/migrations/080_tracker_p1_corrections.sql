-- Migration 080: Tracker P1 corrections (follow-up to 079)
-- ──────────────────────────────────────────────────────────────────────────
-- PR #62 shipped migration 079 (tracker_data_foundation). Testing on a real
-- Postgres 17 database surfaced five blocking bugs. This migration fixes all
-- five WITHOUT editing 079. It is idempotent — safe to re-run — and is safe to
-- apply to a database where 079 is already present (with or without any group
-- already initialised via tracker_init_group).
--
-- The five bugs (and their fixes):
--
--   1. ACTION INSERTS FAIL. The stamp trigger (tracker_stamp) unconditionally
--      sets NEW.created_at on every non-"updates" authored table, but
--      tracker_actions has created_on (a date), NOT created_at. INSERTs into
--      tracker_actions therefore raise "record NEW has no field created_at".
--      → Recreate tracker_stamp so it never touches created_at on
--        tracker_actions (which carries created_on with its own default).
--
--   2. PARENT PLAN DELETION FAILS / CORRUPTS CHILDREN. The parent FK
--      (tracker_project_plans_parent_fk) is a composite FK on (parent_id,
--      group_id) with plain ON DELETE SET NULL, which nulls BOTH parent_id AND
--      group_id on the child — and group_id is NOT NULL, so the delete fails.
--      → Recreate the FK with ON DELETE SET NULL (parent_id) so only parent_id
--        is cleared (PG15+ column-list form, already used by 079 elsewhere).
--
--   3. NAVHUB CANNOT DELETE USERS. tracker_plan_members.user_id,
--      tracker_plan_shares.user_id and tracker_reviews.user_id are NOT NULL
--      (and user_id is part of the PK for members and reviews), yet their FKs
--      to auth.users use ON DELETE SET NULL. Deleting a user tries to NULL a
--      NOT-NULL / PK column and aborts the delete.
--      → Recreate those three FKs as ON DELETE CASCADE: deleting a user
--        removes that user's membership / share / review rows.
--
--   4. NAVHUB CANNOT DELETE GROUPS WITH TRACKER DATA. When a group is deleted,
--      its tracker rows cascade-delete; the activity-log trigger fires for each
--      and tries to INSERT a log row, but tracker_activity_log.group_id FK ->
--      groups(id) now points at the already-deleted group, so the INSERT fails
--      and blocks the whole delete.
--      → Recreate tracker_activity_log_fn to skip logging when the owning group
--        no longer exists (i.e. we are inside a group cascade-delete).
--
--   5. tracker_init_group IS NOT SECURE. The function lacks SECURITY DEFINER
--      and a fixed search_path, so it cannot be safely invoked by a
--      low-privilege / RLS-restricted caller and is exposed to search_path
--      manipulation.
--      → Recreate it with SECURITY DEFINER and SET search_path = public,
--        pg_temp. (The starting lookup VALUES are left exactly as 079 seeded
--        them — see the note at the end of this file.)
--
-- Requires PostgreSQL 15+ (the ON DELETE SET NULL (column) form).

-- ── 1. Bug 1 — stamp trigger must not set created_at on tracker_actions ──────
-- Full-function replacement of tracker_stamp. Identical to 079 EXCEPT the
-- INSERT branch no longer sets created_at for tracker_actions (its date column
-- is created_on, which already defaults to "today"). All other behaviour —
-- created_by/author_id back-fill, updated_at/edited_at bumping, and the
-- plan "only updated_on moved" short-circuit — is preserved verbatim.

CREATE OR REPLACE FUNCTION tracker_stamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'tracker_updates' THEN
      IF NEW.author_id IS NULL AND uid IS NOT NULL THEN
        NEW.author_id := uid;
      END IF;
      NEW.created_at := COALESCE(NEW.created_at, now());
    ELSIF TG_TABLE_NAME = 'tracker_actions' THEN
      -- actions carry created_on (a date, with its own default) and have NO
      -- created_at / updated_at timestamp columns to stamp here.
      IF NEW.created_by IS NULL AND uid IS NOT NULL THEN
        NEW.created_by := uid;
      END IF;
    ELSE
      IF NEW.created_by IS NULL AND uid IS NOT NULL THEN
        NEW.created_by := uid;
      END IF;
      NEW.created_at := COALESCE(NEW.created_at, now());
      NEW.updated_at := COALESCE(NEW.updated_at, now());
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF TG_TABLE_NAME = 'tracker_updates' THEN
    NEW.edited_at := now();
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'tracker_project_plans' THEN
    -- A change that only moves updated_on (the last-updated bump) must not
    -- masquerade as a human edit: leave updated_by / updated_at untouched.
    IF NEW IS DISTINCT FROM OLD
       AND NEW.updated_on IS DISTINCT FROM OLD.updated_on
       AND (to_jsonb(NEW) - 'updated_on') = (to_jsonb(OLD) - 'updated_on') THEN
      RETURN NEW;
    END IF;
  END IF;

  IF uid IS NOT NULL THEN
    NEW.updated_by := uid;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ── 2. Bug 2 — parent FK must clear ONLY parent_id (not group_id) ────────────
-- Drop and recreate the composite parent FK with the column-list SET NULL form
-- so deleting a parent plan blanks the child's parent_id and leaves group_id
-- (NOT NULL) intact.

ALTER TABLE tracker_project_plans
  DROP CONSTRAINT IF EXISTS tracker_project_plans_parent_fk;
DO $$ BEGIN
  ALTER TABLE tracker_project_plans
    ADD CONSTRAINT tracker_project_plans_parent_fk
    FOREIGN KEY (parent_id, group_id)
    REFERENCES tracker_project_plans (id, group_id)
    ON DELETE SET NULL (parent_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. Bug 3 — user_id FKs must CASCADE (they are NOT NULL / part of a PK) ───
-- SET NULL cannot apply to these NOT-NULL (and PK) columns; deleting a user
-- must remove the dependent membership / share / review rows instead.

ALTER TABLE tracker_plan_members
  DROP CONSTRAINT IF EXISTS tracker_plan_members_user_id_fkey;
DO $$ BEGIN
  ALTER TABLE tracker_plan_members
    ADD CONSTRAINT tracker_plan_members_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE tracker_plan_shares
  DROP CONSTRAINT IF EXISTS tracker_plan_shares_user_id_fkey;
DO $$ BEGIN
  ALTER TABLE tracker_plan_shares
    ADD CONSTRAINT tracker_plan_shares_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE tracker_reviews
  DROP CONSTRAINT IF EXISTS tracker_reviews_user_id_fkey;
DO $$ BEGIN
  ALTER TABLE tracker_reviews
    ADD CONSTRAINT tracker_reviews_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 4. Bug 4 — activity-log trigger must not block a group cascade-delete ────
-- Full-function replacement of tracker_activity_log_fn. Identical to 079 EXCEPT
-- it skips the log INSERT when the owning group no longer exists — which is the
-- case while a group is being cascade-deleted, where the log's FK to groups
-- would otherwise fail and abort the delete.

CREATE OR REPLACE FUNCTION tracker_activity_log_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_group_id  uuid;
  v_entity_id uuid;
  v_plan_id   uuid;
  v_verb      text;
  v_diff      jsonb := '{}'::jsonb;
  v_new       jsonb;
  v_old       jsonb;
  v_changed   jsonb := '{}'::jsonb;
  k           text;
BEGIN
  -- entity_id falls back through: id → plan_id → user_id (reviews) → group_id
  -- (settings), so every tracker table yields a non-null uuid for the log.
  IF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD);
    v_group_id  := (v_old ->> 'group_id')::uuid;
    v_entity_id := COALESCE((v_old ->> 'id')::uuid, (v_old ->> 'plan_id')::uuid,
                            (v_old ->> 'user_id')::uuid, (v_old ->> 'group_id')::uuid);
    v_verb := 'deleted';
    v_diff := v_old;
  ELSIF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW);
    v_group_id  := (v_new ->> 'group_id')::uuid;
    v_entity_id := COALESCE((v_new ->> 'id')::uuid, (v_new ->> 'plan_id')::uuid,
                            (v_new ->> 'user_id')::uuid, (v_new ->> 'group_id')::uuid);
    v_verb := 'created';
    v_diff := v_new;
  ELSE -- UPDATE
    v_new := to_jsonb(NEW);
    v_old := to_jsonb(OLD);
    v_group_id  := (v_new ->> 'group_id')::uuid;
    v_entity_id := COALESCE((v_new ->> 'id')::uuid, (v_new ->> 'plan_id')::uuid,
                            (v_new ->> 'user_id')::uuid, (v_new ->> 'group_id')::uuid);
    v_verb := 'updated';

    -- Skip redundant plan-only-updated_on changes.
    IF TG_TABLE_NAME = 'tracker_project_plans'
       AND (v_new ->> 'updated_on') IS DISTINCT FROM (v_old ->> 'updated_on')
       AND (v_new - 'updated_on') = (v_old - 'updated_on') THEN
      RETURN NULL;
    END IF;

    -- Build the changed-columns diff: { col: { old, new } }.
    FOR k IN SELECT jsonb_object_keys(v_new) LOOP
      IF (v_new -> k) IS DISTINCT FROM (v_old -> k) THEN
        v_changed := v_changed || jsonb_build_object(
          k, jsonb_build_object('old', v_old -> k, 'new', v_new -> k));
      END IF;
    END LOOP;

    -- Nothing actually changed → nothing to log.
    IF v_changed = '{}'::jsonb THEN
      RETURN NULL;
    END IF;
    v_diff := v_changed;
  END IF;

  -- Denormalise plan_id: the plan's own id for plans, else the row's plan_id.
  -- v_new holds the row for INSERT/UPDATE; v_old for DELETE.
  IF TG_TABLE_NAME = 'tracker_project_plans' THEN
    v_plan_id := v_entity_id;
  ELSE
    v_plan_id := (COALESCE(v_new, v_old) ->> 'plan_id')::uuid;
  END IF;

  -- Some junction/child tables (plan_members, plan_shares) carry no group_id
  -- column. Derive it from the plan so the NOT NULL log column is satisfied.
  IF v_group_id IS NULL AND v_plan_id IS NOT NULL THEN
    SELECT p.group_id INTO v_group_id
    FROM tracker_project_plans p WHERE p.id = v_plan_id;
  END IF;

  -- If we still cannot attribute a group (e.g. the plan was already deleted in
  -- a cascade), skip logging rather than fail the write.
  IF v_group_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Bug 4 fix: if the owning group itself no longer exists (we are inside a
  -- group cascade-delete), skip logging — otherwise the log's FK to groups(id)
  -- would fail and block the group deletion.
  IF NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = v_group_id) THEN
    RETURN NULL;
  END IF;

  INSERT INTO tracker_activity_log
    (group_id, plan_id, actor_id, entity_type, entity_id, verb, diff)
  VALUES
    (v_group_id, v_plan_id, auth.uid(), TG_TABLE_NAME, v_entity_id, v_verb, v_diff);

  RETURN NULL;
END;
$$;

-- ── 5. Bug 5 — tracker_init_group hardening (SECURITY DEFINER + search_path) ─
-- Full-function replacement. The body (settings defaults + the seven starting
-- lookup lists, all ON CONFLICT DO NOTHING) is UNCHANGED from 079; only the
-- security context is added: SECURITY DEFINER and a fixed search_path so the
-- function is safe to invoke from a low-privilege / RLS-restricted caller and
-- cannot be subverted via search_path manipulation.
--
-- NOTE ON STARTING LISTS: the brief flagged the 079 seed values as "invented"
-- and asked for "the agreed list", but no canonical starting-list definition
-- exists in this repo (docs/tracker/DATA_MODEL.md names the seven lists but not
-- their values). Rather than replace one unverifiable list with another, this
-- migration preserves the 079 seed values verbatim and the operator can supply
-- the agreed list in a focused follow-up if it differs. ON CONFLICT DO NOTHING
-- means such a follow-up can add/adjust rows idempotently.

CREATE OR REPLACE FUNCTION tracker_init_group(p_group_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Settings (defaults per brief). Keep an existing row untouched.
  INSERT INTO tracker_settings (group_id)
  VALUES (p_group_id)
  ON CONFLICT (group_id) DO NOTHING;

  -- Starting lookup lists. (list, key, label, sort_order)
  INSERT INTO tracker_lookups (group_id, list, key, label, sort_order)
  VALUES
    -- category
    (p_group_id, 'category', 'project',     'Project',     0),
    (p_group_id, 'category', 'program',     'Program',     1),
    (p_group_id, 'category', 'bau',         'BAU',         2),
    -- status
    (p_group_id, 'status', 'planned',       'Planned',     0),
    (p_group_id, 'status', 'active',        'Active',      1),
    (p_group_id, 'status', 'on_hold',       'On Hold',     2),
    (p_group_id, 'status', 'complete',      'Complete',    3),
    (p_group_id, 'status', 'cancelled',     'Cancelled',   4),
    -- milestone_status
    (p_group_id, 'milestone_status', 'backlog',     'Backlog',      0),
    (p_group_id, 'milestone_status', 'in_progress', 'In Progress',  1),
    (p_group_id, 'milestone_status', 'blocked',     'Blocked',      2),
    (p_group_id, 'milestone_status', 'done',        'Done',         3),
    -- action_type
    (p_group_id, 'action_type', 'task',       'Task',       0),
    (p_group_id, 'action_type', 'call',       'Call',       1),
    (p_group_id, 'action_type', 'email',      'Email',      2),
    (p_group_id, 'action_type', 'meeting',    'Meeting',    3),
    (p_group_id, 'action_type', 'follow_up',  'Follow Up',  4),
    -- source
    (p_group_id, 'source', 'manual',   'Manual',   0),
    (p_group_id, 'source', 'email',    'Email',    1),
    (p_group_id, 'source', 'meeting',  'Meeting',  2),
    (p_group_id, 'source', 'import',   'Import',   3),
    -- review_step
    (p_group_id, 'review_step', 'overdue',   'Overdue Actions',    0),
    (p_group_id, 'review_step', 'due_soon',  'Due This Week',      1),
    (p_group_id, 'review_step', 'stale',     'Stale Plans',        2),
    (p_group_id, 'review_step', 'contacts',  'Contacts To Chase',  3),
    (p_group_id, 'review_step', 'top3',      'Top 3 For Next Week',4),
    -- region
    (p_group_id, 'region', 'wa',   'Western Australia', 0),
    (p_group_id, 'region', 'nsw',  'New South Wales',   1),
    (p_group_id, 'region', 'vic',  'Victoria',          2),
    (p_group_id, 'region', 'qld',  'Queensland',        3),
    (p_group_id, 'region', 'sa',   'South Australia',   4),
    (p_group_id, 'region', 'tas',  'Tasmania',          5),
    (p_group_id, 'region', 'nt',   'Northern Territory',6),
    (p_group_id, 'region', 'act',  'ACT',               7)
  ON CONFLICT (group_id, list, key) DO NOTHING;
END;
$$;
