-- Migration 079: Tracker data foundation (P1)
-- ──────────────────────────────────────────────────────────────────────────
-- The complete data layer for the Project Tracker. Establishes all 14
-- tracker_* tables, their enums, constraints and indexes; per-group settings
-- and starting lookup lists seeded by an idempotent tracker_init_group();
-- the stamp / last-updated / activity-log triggers; and row-level security
-- ENABLED on every table with NO policies (access rules land in P2 — the
-- whole module is intentionally locked down until then).
--
-- Conventions (per brief):
--   • group_id uuid NOT NULL → groups(id) ON DELETE CASCADE
--   • person columns → auth.users(id) ON DELETE SET NULL
--       (except plans.owner_id: NOT NULL, ON DELETE RESTRICT)
--   • ids uuid PK DEFAULT gen_random_uuid()
--   • "today" = (now() at time zone 'Australia/Perth')::date
--
-- NOTE ON MIGRATION NUMBER: the brief suggested 073, but 073 (and up to 078)
-- are already taken in this repo (Markets). This file uses the next free
-- number, 079, to avoid collision.
--
-- This file is idempotent — safe to re-run. All statements are guarded.

-- ── 0. Enums ────────────────────────────────────────────────────────────────
-- Every enum is prefixed tracker_ to avoid clashes with existing types.
-- PostgreSQL has no CREATE TYPE IF NOT EXISTS, so each is wrapped in a DO
-- block that swallows duplicate_object, keeping the migration re-runnable.

DO $$ BEGIN
  CREATE TYPE tracker_priority AS ENUM ('normal', 'high');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tracker_action_status AS ENUM ('open', 'waiting', 'done');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tracker_milestone_health AS ENUM ('on_track', 'at_risk', 'off_track');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tracker_progress_mode AS ENUM ('manual', 'from_actions');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tracker_share_level AS ENUM ('view', 'comment', 'edit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tracker_update_kind AS ENUM ('update', 'handover');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 1. Settings & lookups ───────────────────────────────────────────────────

-- tracker_settings: one row per group; the per-group tracker configuration.
CREATE TABLE IF NOT EXISTS tracker_settings (
  group_id              uuid PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  chaser_days           integer NOT NULL DEFAULT 5,
  stale_days            integer NOT NULL DEFAULT 21,
  contact_followup_days integer NOT NULL DEFAULT 21,
  review_day            text    NOT NULL DEFAULT 'friday',
  week_start            text    NOT NULL DEFAULT 'monday',
  time_zone             text    NOT NULL DEFAULT 'Australia/Perth'
);

-- tracker_lookups: the per-group configurable reference lists.
CREATE TABLE IF NOT EXISTS tracker_lookups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  list        text NOT NULL CHECK (list IN (
                'category', 'status', 'milestone_status',
                'action_type', 'source', 'region', 'review_step')),
  key         text NOT NULL,
  label       text NOT NULL,
  colour      text,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (group_id, list, key)
);
CREATE INDEX IF NOT EXISTS idx_tracker_lookups_group ON tracker_lookups(group_id);

-- ── 2. Core entities ────────────────────────────────────────────────────────

-- tracker_project_plans: the project plans at the heart of the tracker.
CREATE TABLE IF NOT EXISTS tracker_project_plans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  legacy_id     text,
  name          text NOT NULL,
  category      text,
  status        text,
  client        text,
  phase         text,
  summary       text,
  folder        text,
  region        text,
  parent_id     uuid,
  sort_order    integer NOT NULL DEFAULT 0,
  owner_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  lead_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  start_on      date,
  end_on        date,
  priority      tracker_priority NOT NULL DEFAULT 'normal',
  progress_pct  integer NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_on    date NOT NULL DEFAULT (now() AT TIME ZONE 'Australia/Perth')::date,
  archived_at   timestamptz,
  CONSTRAINT tracker_project_plans_no_self_parent CHECK (parent_id <> id),
  -- Composite unique so composite FKs can reference (id, group_id) and thereby
  -- enforce "same group only" for parents and all child entities.
  UNIQUE (id, group_id)
);
-- Parent plan must exist in the SAME group (composite FK) and cannot be itself
-- (CHECK above). Self-parenting and cross-group parents are both rejected.
DO $$ BEGIN
  ALTER TABLE tracker_project_plans
    ADD CONSTRAINT tracker_project_plans_parent_fk
    FOREIGN KEY (parent_id, group_id)
    REFERENCES tracker_project_plans (id, group_id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- legacy_id unique per group when present (duplicate legacy_id rejection).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracker_project_plans_legacy
  ON tracker_project_plans(group_id, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracker_project_plans_group
  ON tracker_project_plans(group_id);

-- tracker_plan_members: who is on a plan (lead / member).
CREATE TABLE IF NOT EXISTS tracker_plan_members (
  plan_id  uuid NOT NULL REFERENCES tracker_project_plans(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  role     text NOT NULL CHECK (role IN ('lead', 'member')),
  PRIMARY KEY (plan_id, user_id)
);

-- tracker_plan_shares: external-of-the-team sharing at a given level.
CREATE TABLE IF NOT EXISTS tracker_plan_shares (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id    uuid NOT NULL REFERENCES tracker_project_plans(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  level      tracker_share_level NOT NULL,
  shared_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, user_id)
);

-- tracker_milestones: milestones within a plan.
CREATE TABLE IF NOT EXISTS tracker_milestones (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id                  uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  plan_id                   uuid NOT NULL,
  legacy_id                 text,
  title                     text NOT NULL,
  description               text,
  owner_id                  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  priority                  tracker_priority NOT NULL DEFAULT 'normal',
  status                    text NOT NULL DEFAULT 'backlog',
  health                    tracker_milestone_health NOT NULL DEFAULT 'on_track',
  start_on                  date,
  due_on                    date,
  baseline_due_on           date,
  estimated_completion_on   date,
  completed_on              date,
  progress_mode             tracker_progress_mode NOT NULL DEFAULT 'manual',
  progress_pct              integer NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  estimated_hours           numeric CHECK (estimated_hours >= 0),
  actual_hours              numeric CHECK (actual_hours >= 0),
  depends_on_ids            uuid[] NOT NULL DEFAULT '{}',
  sort_order                integer NOT NULL DEFAULT 0,
  created_by                uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by                uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  archived_at               timestamptz,
  UNIQUE (id, group_id),
  -- plan must exist in the SAME group (composite FK).
  FOREIGN KEY (plan_id, group_id)
    REFERENCES tracker_project_plans (id, group_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracker_milestones_legacy
  ON tracker_milestones(plan_id, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracker_milestones_group
  ON tracker_milestones(group_id);
CREATE INDEX IF NOT EXISTS idx_tracker_milestones_plan_group
  ON tracker_milestones(plan_id, group_id);
CREATE INDEX IF NOT EXISTS idx_tracker_milestones_status_due
  ON tracker_milestones(status, due_on);

-- tracker_contacts: people/organisations linked to plans.
-- (Defined before tracker_actions because actions reference contacts.)
CREATE TABLE IF NOT EXISTS tracker_contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  legacy_id     text,
  name          text NOT NULL,
  org           text,
  role          text,
  phone         text,
  email         text,
  notes         text,
  last_contact  date,
  owner_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  UNIQUE (id, group_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracker_contacts_legacy
  ON tracker_contacts(group_id, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracker_contacts_group
  ON tracker_contacts(group_id);

-- tracker_actions: the task/action items.
CREATE TABLE IF NOT EXISTS tracker_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  legacy_id     text,
  plan_id       uuid,
  milestone_id  uuid,
  title         text NOT NULL,
  type          text,
  who           text,
  contact_id    uuid REFERENCES tracker_contacts(id) ON DELETE SET NULL,
  assignee_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  due_on        date,
  status        tracker_action_status NOT NULL DEFAULT 'open',
  priority      tracker_priority NOT NULL DEFAULT 'normal',
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_on    date NOT NULL DEFAULT (now() AT TIME ZONE 'Australia/Perth')::date,
  updated_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  waiting_since date,
  done_on       date,
  archived_at   timestamptz,
  -- plan (optional) must be in the same group; milestone (optional) likewise,
  -- but detaching a milestone only NULLs milestone_id (SET NULL).
  FOREIGN KEY (plan_id, group_id)
    REFERENCES tracker_project_plans (id, group_id) ON DELETE CASCADE,
  FOREIGN KEY (milestone_id, group_id)
    REFERENCES tracker_milestones (id, group_id) ON DELETE SET NULL (milestone_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracker_actions_legacy
  ON tracker_actions(group_id, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracker_actions_group
  ON tracker_actions(group_id);
CREATE INDEX IF NOT EXISTS idx_tracker_actions_plan_group
  ON tracker_actions(plan_id, group_id);
CREATE INDEX IF NOT EXISTS idx_tracker_actions_milestone_group
  ON tracker_actions(milestone_id, group_id);
CREATE INDEX IF NOT EXISTS idx_tracker_actions_assignee
  ON tracker_actions(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tracker_actions_status_due
  ON tracker_actions(status, due_on);

-- tracker_updates: the dated narrative updates / handovers on a plan.
CREATE TABLE IF NOT EXISTS tracker_updates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  plan_id    uuid NOT NULL,
  legacy_id  text,
  kind       tracker_update_kind NOT NULL DEFAULT 'update',
  date       date NOT NULL DEFAULT (now() AT TIME ZONE 'Australia/Perth')::date,
  source     text,
  text       text NOT NULL,
  author_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at  timestamptz,
  FOREIGN KEY (plan_id, group_id)
    REFERENCES tracker_project_plans (id, group_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracker_updates_legacy
  ON tracker_updates(group_id, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracker_updates_group
  ON tracker_updates(group_id);
CREATE INDEX IF NOT EXISTS idx_tracker_updates_plan_group
  ON tracker_updates(plan_id, group_id);

-- tracker_contact_plans: many-to-many contacts ↔ plans.
CREATE TABLE IF NOT EXISTS tracker_contact_plans (
  contact_id uuid NOT NULL,
  plan_id    uuid NOT NULL,
  group_id   uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, plan_id),
  FOREIGN KEY (contact_id, group_id)
    REFERENCES tracker_contacts (id, group_id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id, group_id)
    REFERENCES tracker_project_plans (id, group_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tracker_contact_plans_group
  ON tracker_contact_plans(group_id);
CREATE INDEX IF NOT EXISTS idx_tracker_contact_plans_plan_group
  ON tracker_contact_plans(plan_id, group_id);

-- tracker_comments: threaded comments on plan/milestone/action entities.
CREATE TABLE IF NOT EXISTS tracker_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  plan_id     uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('plan', 'milestone', 'action')),
  entity_id   uuid NOT NULL,
  author_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  edited_at   timestamptz,
  deleted_at  timestamptz,
  FOREIGN KEY (plan_id, group_id)
    REFERENCES tracker_project_plans (id, group_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tracker_comments_group
  ON tracker_comments(group_id);
CREATE INDEX IF NOT EXISTS idx_tracker_comments_plan_group
  ON tracker_comments(plan_id, group_id);
CREATE INDEX IF NOT EXISTS idx_tracker_comments_entity
  ON tracker_comments(entity_type, entity_id);

-- tracker_reviews: per-user weekly review state (ISO week keyed).
CREATE TABLE IF NOT EXISTS tracker_reviews (
  group_id   uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  iso_week   text NOT NULL CHECK (iso_week ~ '^[0-9]{4}-W[0-9]{2}$'),
  checks     jsonb NOT NULL DEFAULT '{}',
  top3       text,
  notes      text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id, iso_week)
);
CREATE INDEX IF NOT EXISTS idx_tracker_reviews_user_week
  ON tracker_reviews(user_id, iso_week);

-- tracker_activity_log: the append-only audit trail. plan_id is denormalised
-- (no FK) so the log survives plan deletion and never blocks a write.
CREATE TABLE IF NOT EXISTS tracker_activity_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  plan_id     uuid,
  actor_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,
  verb        text NOT NULL CHECK (verb IN ('created', 'updated', 'deleted')),
  diff        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tracker_activity_log_group
  ON tracker_activity_log(group_id);
CREATE INDEX IF NOT EXISTS idx_tracker_activity_log_entity
  ON tracker_activity_log(entity_type, entity_id);

-- tracker_import_jobs: the import preview/apply job records.
CREATE TABLE IF NOT EXISTS tracker_import_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  file_name   text,
  status      text NOT NULL CHECK (status IN ('previewed', 'applied', 'failed', 'cancelled')),
  summary     jsonb NOT NULL DEFAULT '{}',
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  applied_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_tracker_import_jobs_group
  ON tracker_import_jobs(group_id);

-- ── 3. tracker_init_group(group_id) ─────────────────────────────────────────
-- Idempotent per-group bootstrap: inserts the settings row with defaults and
-- seeds the starting lookup lists. Safe to call repeatedly (ON CONFLICT DO
-- NOTHING on every row), so re-running never duplicates or overwrites.

CREATE OR REPLACE FUNCTION tracker_init_group(p_group_id uuid)
RETURNS void
LANGUAGE plpgsql
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

-- ── 4. Stamp trigger (FR-1.6) ───────────────────────────────────────────────
-- BEFORE INSERT/UPDATE on plans, milestones, actions, contacts, updates.
--   • INSERT: fill created_by / author_id = auth.uid() when null; stamp the
--     created-timestamp. Passed values are kept when auth.uid() is null.
--   • UPDATE: set updated_by = auth.uid(), bump updated_at/edited_at — EXCEPT
--     a plan change that only moves updated_on, which leaves updated_by /
--     updated_at alone (so an automatic last-updated bump is not mistaken for
--     a human edit).

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
    ELSE
      IF NEW.created_by IS NULL AND uid IS NOT NULL THEN
        NEW.created_by := uid;
      END IF;
      NEW.created_at := COALESCE(NEW.created_at, now());
      -- actions carry created_on (date); others carry updated_at too.
      IF TG_TABLE_NAME <> 'tracker_actions' THEN
        NEW.updated_at := COALESCE(NEW.updated_at, now());
      END IF;
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

-- ── 5. Last-updated trigger ─────────────────────────────────────────────────
-- Two behaviours:
--   (a) BEFORE UPDATE on plans: when any non-updated_on column changes, set
--       updated_on to "today" in the group's time zone — unless the session
--       GUC app.tracker_preserve_updated_on = 'on' (used by imports/back-fills).
--   (b) AFTER INSERT/UPDATE of a plan-dated row (updates): move the plan's
--       updated_on FORWARD only if the row's date is later. Earlier-dated rows
--       never pull updated_on backward.
-- The forward move in (b) sets app.tracker_preserve_updated_on inside the
-- statement so the plan's own BEFORE UPDATE trigger does not re-stamp it.

CREATE OR REPLACE FUNCTION tracker_plan_touch_updated_on()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tz   text;
  preserve text := current_setting('app.tracker_preserve_updated_on', true);
BEGIN
  IF preserve = 'on' THEN
    RETURN NEW;
  END IF;
  -- Only re-stamp when a column OTHER than updated_on actually changed.
  IF (to_jsonb(NEW) - 'updated_on') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_on') THEN
    SELECT s.time_zone INTO tz FROM tracker_settings s WHERE s.group_id = NEW.group_id;
    tz := COALESCE(tz, 'Australia/Perth');
    NEW.updated_on := (now() AT TIME ZONE tz)::date;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tracker_update_moves_plan_updated_on()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cur_updated_on date;
  prior_preserve text;
BEGIN
  SELECT p.updated_on INTO cur_updated_on
  FROM tracker_project_plans p
  WHERE p.id = NEW.plan_id;

  -- Move forward only; earlier-dated updates never pull it back.
  IF cur_updated_on IS NULL OR NEW.date > cur_updated_on THEN
    -- Preserve flag stops the plan's own last-updated trigger re-stamping to
    -- today; we want the update's (later) date to win. Save and restore any
    -- caller-set value so an import-wide preserve='on' is not clobbered.
    prior_preserve := current_setting('app.tracker_preserve_updated_on', true);
    PERFORM set_config('app.tracker_preserve_updated_on', 'on', true);
    UPDATE tracker_project_plans
      SET updated_on = NEW.date
      WHERE id = NEW.plan_id;
    PERFORM set_config('app.tracker_preserve_updated_on', COALESCE(prior_preserve, 'off'), true);
  END IF;
  RETURN NULL;
END;
$$;

-- ── 6. Activity-log trigger ─────────────────────────────────────────────────
-- AFTER INSERT/UPDATE/DELETE on every tracker table EXCEPT the log itself.
-- Logs actor_id (auth.uid()), entity_type (table), entity_id, verb, and a
-- diff: full new row (created), full old row (deleted), or the set of changed
-- columns {old, new} (updated). A plan change that ONLY moved updated_on is
-- skipped as redundant (no human-meaningful change). plan_id is denormalised
-- in: the plan's own id for plans, else the row's plan_id when present.

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

  INSERT INTO tracker_activity_log
    (group_id, plan_id, actor_id, entity_type, entity_id, verb, diff)
  VALUES
    (v_group_id, v_plan_id, auth.uid(), TG_TABLE_NAME, v_entity_id, v_verb, v_diff);

  RETURN NULL;
END;
$$;

-- ── 7. Attach triggers ──────────────────────────────────────────────────────

-- Stamp (BEFORE INSERT/UPDATE) on the five authored tables.
DO $$
DECLARE
  t text;
  stamped text[] := ARRAY[
    'tracker_project_plans', 'tracker_milestones', 'tracker_actions',
    'tracker_contacts', 'tracker_updates'
  ];
BEGIN
  FOREACH t IN ARRAY stamped LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_tracker_stamp ON %I;', t);
    EXECUTE format(
      'CREATE TRIGGER trg_tracker_stamp BEFORE INSERT OR UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION tracker_stamp();', t);
  END LOOP;
END $$;

-- Last-updated: BEFORE UPDATE on plans (re-stamp updated_on).
DROP TRIGGER IF EXISTS trg_tracker_plan_touch_updated_on ON tracker_project_plans;
CREATE TRIGGER trg_tracker_plan_touch_updated_on
  BEFORE UPDATE ON tracker_project_plans
  FOR EACH ROW EXECUTE FUNCTION tracker_plan_touch_updated_on();

-- Last-updated: AFTER INSERT/UPDATE on updates (move plan forward).
DROP TRIGGER IF EXISTS trg_tracker_update_moves_plan ON tracker_updates;
CREATE TRIGGER trg_tracker_update_moves_plan
  AFTER INSERT OR UPDATE OF date ON tracker_updates
  FOR EACH ROW EXECUTE FUNCTION tracker_update_moves_plan_updated_on();

-- Activity log: AFTER INSERT/UPDATE/DELETE on all tracker tables except the
-- log itself.
DO $$
DECLARE
  t text;
  logged text[] := ARRAY[
    'tracker_settings', 'tracker_lookups', 'tracker_project_plans',
    'tracker_plan_members', 'tracker_plan_shares', 'tracker_milestones',
    'tracker_actions', 'tracker_updates', 'tracker_contacts',
    'tracker_contact_plans', 'tracker_comments', 'tracker_reviews',
    'tracker_import_jobs'
  ];
BEGIN
  FOREACH t IN ARRAY logged LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_tracker_activity_log ON %I;', t);
    EXECUTE format(
      'CREATE TRIGGER trg_tracker_activity_log
         AFTER INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION tracker_activity_log_fn();', t);
  END LOOP;
END $$;

-- ── 8. Row-level security (ENABLE only — NO policies; access rules in P2) ────
-- Every tracker table has RLS enabled with zero policies, so the module is
-- fully locked to anon/authenticated callers until P2 adds access rules. The
-- service role (and these SECURITY-INVOKER triggers running as the writing
-- role) are unaffected; the triggers' own INSERTs into the log are definer-
-- neutral because RLS does not apply to the table owner / service role.

DO $$
DECLARE
  t text;
  all_tables text[] := ARRAY[
    'tracker_settings', 'tracker_lookups', 'tracker_project_plans',
    'tracker_plan_members', 'tracker_plan_shares', 'tracker_milestones',
    'tracker_actions', 'tracker_updates', 'tracker_contacts',
    'tracker_contact_plans', 'tracker_comments', 'tracker_reviews',
    'tracker_activity_log', 'tracker_import_jobs'
  ];
BEGIN
  FOREACH t IN ARRAY all_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;
