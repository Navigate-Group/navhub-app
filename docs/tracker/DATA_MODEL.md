# Tracker — Data Model (condensed)

The canonical data model for the Project Tracker, as implemented by migration
`supabase/migrations/079_tracker_data_foundation.sql` (P1) and corrected by
`supabase/migrations/080_tracker_p1_corrections.sql` (P1 follow-up — fixes five
bugs found testing on a real Postgres 17 DB; see the **P1 corrections** note
below). Later phases build on this; keep it in sync with both migrations.

> **Migration number note:** the originating brief suggested `073`, but `073`
> through `078` were already taken (Markets). The foundation ships as `079`;
> the corrections ship as `080`.

## Conventions

- `group_id uuid NOT NULL → groups(id) ON DELETE CASCADE` on every group-scoped table.
- Person columns → `auth.users(id) ON DELETE SET NULL`, **except**
  `tracker_project_plans.owner_id` (`NOT NULL`, `ON DELETE RESTRICT`) and the
  NOT-NULL / PK `user_id` columns on `tracker_plan_members`,
  `tracker_plan_shares` and `tracker_reviews` (`ON DELETE CASCADE` — 080; a
  SET-NULL there would violate NOT NULL / the PK and block user deletion).
- Primary keys: `uuid PRIMARY KEY DEFAULT gen_random_uuid()` (unless a composite PK is stated).
- `"today"` = `(now() AT TIME ZONE 'Australia/Perth')::date`.
- Composite FKs `(x_id, group_id) → parent(id, group_id)` enforce **same-group-only** references.
- Requires **PostgreSQL 15+** (the actions→milestones FK uses `ON DELETE SET NULL (column)`).

## Enums (all prefixed `tracker_`)

| Type | Values |
| --- | --- |
| `tracker_priority` | `normal`, `high` |
| `tracker_action_status` | `open`, `waiting`, `done` |
| `tracker_milestone_health` | `on_track`, `at_risk`, `off_track` |
| `tracker_progress_mode` | `manual`, `from_actions` |
| `tracker_share_level` | `view`, `comment`, `edit` |
| `tracker_update_kind` | `update`, `handover` |

## Tables (14)

### `tracker_settings`
One row per group. `group_id` PK → groups CASCADE. `chaser_days int NN 5`;
`stale_days int NN 21`; `contact_followup_days int NN 21`; `review_day text NN 'friday'`;
`week_start text NN 'monday'`; `time_zone text NN 'Australia/Perth'`.

### `tracker_lookups`
`id`; `group_id`; `list text NN CHECK IN (category, status, milestone_status,
action_type, source, region, review_step)`; `key text NN`; `label text NN`;
`colour text`; `sort_order int NN 0`; `active bool NN true`. **UNIQUE(group_id, list, key)**.

### `tracker_project_plans`
`id`; `group_id`; `legacy_id text`; `name text NN`; `category`, `status`, `client`,
`phase`, `summary`, `folder`, `region` text null; `parent_id uuid null`;
`sort_order int NN 0`; `owner_id NN → users RESTRICT`; `lead_id null`;
`start_on`, `end_on` date null; `priority tracker_priority NN 'normal'`;
`progress_pct int NN 0 CHECK 0–100`; `created_by`, `updated_by` null;
`created_at`, `updated_at` timestamptz NN now(); `updated_on date NN today`;
`archived_at` null.
**UNIQUE(id, group_id)**; **UNIQUE(group_id, legacy_id) WHERE legacy_id IS NOT NULL**;
FK `(parent_id, group_id) → (id, group_id)` **ON DELETE SET NULL (parent_id)**
(080 — clears only `parent_id`, never `group_id`); **CHECK `parent_id <> id`**.

### `tracker_plan_members`
`plan_id NN → plans CASCADE`; `user_id NN → users CASCADE` (080); `role text NN CHECK IN (lead, member)`.
**PK(plan_id, user_id)**.

### `tracker_plan_shares`
`id`; `plan_id NN → plans CASCADE`; `user_id NN → users CASCADE` (080); `level tracker_share_level NN`;
`shared_by null`; `created_at NN now()`. **UNIQUE(plan_id, user_id)**.

### `tracker_milestones`
`id`; `group_id`; `plan_id NN` with FK `(plan_id, group_id) → plans CASCADE`;
`legacy_id text`; `title NN`; `description null`; `owner_id null`;
`priority NN 'normal'`; `status text NN 'backlog'`; `health NN 'on_track'`;
`start_on`, `due_on`, `baseline_due_on`, `estimated_completion_on`, `completed_on`
date null; `progress_mode NN 'manual'`; `progress_pct int NN 0 CHECK 0–100`;
`estimated_hours`, `actual_hours` numeric null `CHECK >= 0`; `depends_on_ids uuid[] NN '{}'`;
`sort_order int NN 0`; `created_by`, `updated_by` null; `created_at`, `updated_at NN now()`;
`archived_at` null. **UNIQUE(id, group_id)**; **UNIQUE(plan_id, legacy_id) WHERE NOT NULL**.

### `tracker_actions`
`id`; `group_id`; `legacy_id text`; `plan_id null` FK `(plan_id, group_id) → plans CASCADE`;
`milestone_id null` FK `(milestone_id, group_id) → milestones ON DELETE SET NULL (milestone_id)`;
`title NN`; `type text null`; `who text null`; `contact_id null → contacts SET NULL`;
`assignee_id null`; `due_on date null`; `status NN 'open'`; `priority NN 'normal'`;
`notes null`; `created_by null`; `created_on date NN today`; `updated_by null`;
`updated_at NN now()`; `waiting_since`, `done_on` date null; `archived_at` null.
**UNIQUE(group_id, legacy_id) WHERE NOT NULL**.

### `tracker_updates`
`id`; `group_id`; `plan_id NN` FK `(plan_id, group_id) → plans CASCADE`;
`legacy_id text`; `kind NN 'update'`; `date date NN today`; `source text null`;
`text text NN`; `author_id null`; `created_at NN now()`; `edited_at null`.
**UNIQUE(group_id, legacy_id) WHERE NOT NULL**.

### `tracker_contacts`
`id`; `group_id`; `legacy_id text`; `name NN`; `org`, `role`, `phone`, `email`,
`notes` text null; `last_contact date null`; `owner_id null`; `created_by`,
`updated_by` null; `created_at`, `updated_at NN now()`; `archived_at` null.
**UNIQUE(id, group_id)**; **UNIQUE(group_id, legacy_id) WHERE NOT NULL**.

### `tracker_contact_plans`
`contact_id NN`; `plan_id NN`; `group_id NN`. **PK(contact_id, plan_id)**;
FK `(contact_id, group_id) → contacts CASCADE`; FK `(plan_id, group_id) → plans CASCADE`.

### `tracker_comments`
`id`; `group_id`; `plan_id NN` FK `(plan_id, group_id) → plans CASCADE`;
`entity_type text NN CHECK IN (plan, milestone, action)`; `entity_id uuid NN`;
`author_id null`; `body text NN`; `created_at NN now()`; `edited_at`, `deleted_at` null.

### `tracker_reviews`
`group_id`; `user_id NN → users CASCADE` (080); `iso_week text NN CHECK '^[0-9]{4}-W[0-9]{2}$'`;
`checks jsonb NN '{}'`; `top3`, `notes` text null; `updated_at NN now()`.
**PK(group_id, user_id, iso_week)**.

### `tracker_activity_log`
`id`; `group_id`; `plan_id uuid null` (no FK); `actor_id null`; `entity_type text NN`;
`entity_id uuid NN`; `verb text NN CHECK IN (created, updated, deleted)`;
`diff jsonb NN '{}'`; `created_at NN now()`.

### `tracker_import_jobs`
`id`; `group_id`; `file_name text null`; `status text NN CHECK IN (previewed,
applied, failed, cancelled)`; `summary jsonb NN '{}'`; `created_by null`;
`created_at NN now()`; `applied_at null`.

## Indexes

`(group_id)` on every group-scoped table; `(plan_id, group_id)` on milestones,
actions, updates, contact_plans, comments; `(milestone_id, group_id)` on actions;
`(assignee_id)` and `(status, due_on)` on actions; `(status, due_on)` on milestones;
`(entity_type, entity_id)` on comments and activity_log; `(user_id, iso_week)` on reviews.

## `tracker_init_group(group_id uuid) → void`

Idempotent per-group bootstrap, **`SECURITY DEFINER` with `SET search_path =
public, pg_temp`** (080), all inserts `ON CONFLICT DO NOTHING`:

- Creates the `tracker_settings` row with defaults (chaser 5, stale 21,
  contact_followup 21, review_day friday, week_start monday, tz Australia/Perth).
- Seeds starting lookup values for all seven lists: `category`, `status`,
  `milestone_status`, `action_type`, `source`, `review_step`, `region`.

## Triggers

### Stamp (FR-1.6) — `BEFORE INSERT/UPDATE`
On plans, milestones, actions, contacts, updates:
- INSERT: set `created_by` (or `author_id` for updates) = `auth.uid()` when null;
  set the created-timestamp. Passed values are kept when `auth.uid()` is null.
  **`tracker_actions` has no `created_at`/`updated_at` (it carries `created_on`,
  a date, with its own default), so the trigger does not stamp timestamps on it**
  (080 — the 079 version wrongly set `created_at` and broke every action insert).
- UPDATE: set `updated_by` = `auth.uid()`, bump `updated_at` (`edited_at` for updates).
- A plan change that **only** moves `updated_on` leaves `updated_by`/`updated_at` alone.

### Last-updated
- **plans `BEFORE UPDATE`:** when any non-`updated_on` column changes, set
  `updated_on` to today in the group's time zone (from `tracker_settings.time_zone`,
  default Australia/Perth) — unless session GUC `app.tracker_preserve_updated_on = 'on'`.
- **updates `AFTER INSERT/UPDATE OF date`:** move the plan's `updated_on` **forward
  only** if the update's `date` is later; earlier-dated updates never move it back.

### Activity log — `AFTER INSERT/UPDATE/DELETE`
On every tracker table **except the log itself**. Logs `actor_id` (`auth.uid()`),
`entity_type` (table name), `entity_id`, `verb` (created/updated/deleted), and a
`diff`: full new row (created), full old row (deleted), or changed columns
`{col: {old, new}}` (updated). Skips redundant plan-only-`updated_on` changes.
Denormalises `plan_id` (the plan's own id for plans; the row's `plan_id` otherwise).
**Skips the log INSERT when the owning group no longer exists** (080 — i.e.
during a group cascade-delete; otherwise the log's `group_id` FK to `groups`
would fail and block the group deletion).

## Row-level security

RLS is **ENABLED on all 14 tables** (079). In P1 it ships with **no policies** —
the module is fully locked to anon/authenticated callers (service role bypasses
RLS). **Access rules land in P2** (see below).

## Access rules (P2, migration 082)

Migration `supabase/migrations/082_tracker_access_rules.sql` adds the row-level
security policies and guards for all 14 `tracker_*` tables, so access is enforced
by the database, not the app. Base access comes from the person's **current
NavHub role in the group** (`user_groups.role`, never copied into tracker
tables); removing someone from the group ends all their access at once.

| Who (NavHub role in the group) | In the group's tracker |
|---|---|
| Manager, Group Owner | Full: read and edit every project, create projects, give project access, settings, archive; the plan's owner deletes permanently |
| Any other member (Staff, Group Admin, Super Admin, Viewer, …) | Read every project. Plus Comment or Edit on the specific projects a Manager / Group Owner gives them access to |
| An action's assignee | May also change that action's status and due date |
| Not a member of the group | Nothing |

- Access to a project includes all its sub-projects. Access to a sub-project
  alone does not open its parent.
- Weekly reviews are private to their owner. Nobody edits the activity log.
- Roles are read live from `user_groups`; removing someone from the group ends
  all their access at once.
- Two deliberate changes from the original spec: project access can go to any
  non-editor member of the group (not only Staff), and access to a project
  includes its sub-projects.

Policies apply to the `authenticated` role only (anon sees nothing). The migration
also makes `tracker_init_group` editor-only, runs the activity-log and
last-updated triggers as the owner (so they bypass RLS), and adds guards for the
column-level rules RLS cannot express (plan owner/archive, assignee-only columns
on actions, comment authorship, project-access level).
