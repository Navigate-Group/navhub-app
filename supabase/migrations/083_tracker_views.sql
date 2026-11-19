-- Migration 083: Tracker calculated views (P3)
-- ──────────────────────────────────────────────────────────────────────────
-- Five read-only views that give the screens their numbers. Every view is
-- security_invoker, so it returns only rows the reader may see (082's RLS).
-- The same rules live in lib/tracker/domain.ts; both must give the same
-- numbers (supabase/tests/083_tracker_views_test.sql and
-- lib/tracker/domain.test.ts check one shared fixture).
--
-- Rules
--   • today = the group's time zone (tracker_settings, default Australia/Perth);
--     weeks start on the group's week_start (monday | sunday).
--   • Archived plans and actions are ignored, and so are actions on an
--     archived plan. A plan is active unless its status is 'finished'.
--   • Open action = status open or waiting. Next action = the earliest-due
--     action with status 'open' (undated last; then created_on, then id).
--   • Overdue action = status 'open' and due before today.
--   • A plan needs attention (active plans only) when its status is at_risk,
--     blocked or needs_status_check; or it has no open action; or an overdue
--     action; or today - last updated >= stale_days. Last updated = the later
--     of the plan's updated_on and its newest update. A parent counts the
--     actions of all its sub-plans.
--   • Waiting too long = status 'waiting' and today - waiting_since > chaser_days.
--   • "My" plans (tiles, health checks) = active plans I own or lead.
--
-- Requires 079–082. Only tracker_* objects are added. Safe to re-run.

-- ── 1. Date helpers ─────────────────────────────────────────────────────────
-- Today in the group's time zone. The app.tracker_today setting exists only so
-- tests can pin "today"; the app never sets it.
CREATE OR REPLACE FUNCTION tracker_today(p_group_id uuid)
RETURNS date
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.tracker_today', true), '')::date,
    (now() AT TIME ZONE COALESCE(
      (SELECT s.time_zone FROM tracker_settings s WHERE s.group_id = p_group_id),
      'Australia/Perth'))::date)
$$;

-- First day of the week containing p_day.
CREATE OR REPLACE FUNCTION tracker_week_start(p_day date, p_week_start text)
RETURNS date
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_week_start = 'sunday'
    THEN p_day - EXTRACT(dow FROM p_day)::int
    ELSE p_day - (EXTRACT(isodow FROM p_day)::int - 1) END
$$;

-- ── 2. tracker_v_plan_attention: one row per non-archived plan ─────────────
CREATE OR REPLACE VIEW tracker_v_plan_attention WITH (security_invoker = true) AS
WITH RECURSIVE tree AS (
  SELECT p.id AS plan_id, p.id AS member_id, 0 AS depth
  FROM tracker_project_plans p
  WHERE p.archived_at IS NULL
  UNION ALL
  SELECT t.plan_id, c.id, t.depth + 1
  FROM tree t
  JOIN tracker_project_plans c ON c.parent_id = t.member_id AND c.archived_at IS NULL
  WHERE t.depth < 20
),
acts AS (
  SELECT t.plan_id, a.id, a.title, a.status, a.due_on, a.created_on
  FROM tree t
  JOIN tracker_actions a ON a.plan_id = t.member_id AND a.archived_at IS NULL
),
base AS (
  SELECT p.id AS plan_id, p.group_id, p.parent_id, p.owner_id, p.lead_id, p.status,
         p.status IS DISTINCT FROM 'finished' AS is_active,
         tracker_today(p.group_id) AS today,
         COALESCE(s.stale_days, 21) AS stale_days,
         GREATEST(p.updated_on,
           (SELECT max(u.date) FROM tracker_updates u WHERE u.plan_id = p.id)) AS last_updated
  FROM tracker_project_plans p
  LEFT JOIN tracker_settings s ON s.group_id = p.group_id
  WHERE p.archived_at IS NULL
),
calc AS (
  SELECT b.*,
    (SELECT count(*) FROM acts a WHERE a.plan_id = b.plan_id AND a.status IN ('open', 'waiting'))::int AS open_actions,
    EXISTS (SELECT 1 FROM acts a WHERE a.plan_id = b.plan_id AND a.status = 'open' AND a.due_on < b.today) AS has_overdue,
    (SELECT count(*) FROM tracker_project_plans c WHERE c.parent_id = b.plan_id AND c.archived_at IS NULL)::int AS sub_plans,
    nx.id AS next_action_id, nx.title AS next_action_title, nx.due_on AS next_action_due
  FROM base b
  LEFT JOIN LATERAL (
    SELECT a.id, a.title, a.due_on FROM acts a
    WHERE a.plan_id = b.plan_id AND a.status = 'open'
    ORDER BY a.due_on NULLS LAST, a.created_on, a.id
    LIMIT 1
  ) nx ON true
)
SELECT plan_id, group_id, parent_id, owner_id, lead_id, status, is_active,
       last_updated, open_actions, sub_plans,
       next_action_id, next_action_title, next_action_due,
       (is_active AND COALESCE(status IN ('at_risk', 'blocked', 'needs_status_check'), false)) AS flag_status,
       (is_active AND open_actions = 0)                         AS flag_no_open_action,
       (is_active AND has_overdue)                              AS flag_overdue_action,
       (is_active AND (today - last_updated) >= stale_days)     AS flag_stale,
       (is_active AND (COALESCE(status IN ('at_risk', 'blocked', 'needs_status_check'), false)
                       OR open_actions = 0 OR has_overdue
                       OR (today - last_updated) >= stale_days)) AS needs_attention
FROM calc;

-- ── 3. tracker_v_milestone_progress: one row per non-archived milestone ─────
CREATE OR REPLACE VIEW tracker_v_milestone_progress WITH (security_invoker = true) AS
SELECT m.id AS milestone_id, m.group_id, m.plan_id, m.status, m.due_on, m.baseline_due_on,
       count(a.id) FILTER (WHERE a.status = 'done')::int AS done_actions,
       count(a.id)::int AS total_actions,
       CASE WHEN m.progress_mode = 'from_actions'
         THEN CASE WHEN count(a.id) = 0 THEN 0
           ELSE round(100.0 * count(a.id) FILTER (WHERE a.status = 'done') / count(a.id))::int END
         ELSE m.progress_pct END AS progress_pct,
       (m.due_on - m.baseline_due_on) AS days_slipped,
       (m.due_on IS NOT NULL AND m.due_on < tracker_today(m.group_id)
        AND m.status NOT IN ('completed', 'cancelled')) AS overdue
FROM tracker_milestones m
LEFT JOIN tracker_actions a ON a.milestone_id = m.id AND a.archived_at IS NULL
WHERE m.archived_at IS NULL
GROUP BY m.id;

-- Shared base for the per-person views: the person's live actions, and the
-- people who appear in a group (assignees, plan owners and leads).
-- ── 4. tracker_v_action_counts: the six My week tiles, per person ───────────
CREATE OR REPLACE VIEW tracker_v_action_counts WITH (security_invoker = true) AS
WITH live_actions AS (
  SELECT a.* FROM tracker_actions a
  LEFT JOIN tracker_project_plans p ON p.id = a.plan_id
  WHERE a.archived_at IS NULL AND (a.plan_id IS NULL OR p.archived_at IS NULL)
),
people AS (
  SELECT group_id, assignee_id AS user_id FROM live_actions WHERE assignee_id IS NOT NULL
  UNION SELECT group_id, owner_id FROM tracker_project_plans WHERE archived_at IS NULL
  UNION SELECT group_id, lead_id FROM tracker_project_plans WHERE archived_at IS NULL AND lead_id IS NOT NULL
),
ctx AS (
  SELECT pe.group_id, pe.user_id, tracker_today(pe.group_id) AS today,
         tracker_week_start(tracker_today(pe.group_id), COALESCE(s.week_start, 'monday')) AS wk
  FROM people pe LEFT JOIN tracker_settings s ON s.group_id = pe.group_id
)
SELECT c.group_id, c.user_id,
  (SELECT count(*) FROM live_actions a WHERE a.group_id = c.group_id AND a.assignee_id = c.user_id
     AND a.status = 'open' AND a.due_on < c.today)::int AS overdue,
  (SELECT count(*) FROM live_actions a WHERE a.group_id = c.group_id AND a.assignee_id = c.user_id
     AND a.status = 'open' AND a.due_on BETWEEN c.today AND c.wk + 6)::int AS due_this_week,
  (SELECT count(*) FROM live_actions a WHERE a.group_id = c.group_id AND a.assignee_id = c.user_id
     AND a.status = 'waiting')::int AS waiting_on_others,
  (SELECT count(*) FROM live_actions a WHERE a.group_id = c.group_id AND a.assignee_id = c.user_id
     AND a.status = 'open' AND a.type IN ('call', 'email'))::int AS calls_and_emails,
  (SELECT count(*) FROM tracker_v_plan_attention pa WHERE pa.group_id = c.group_id
     AND (pa.owner_id = c.user_id OR pa.lead_id = c.user_id) AND pa.needs_attention)::int AS plans_needing_attention,
  (SELECT count(*) FROM live_actions a WHERE a.group_id = c.group_id AND a.assignee_id = c.user_id
     AND a.status = 'done' AND a.done_on BETWEEN c.wk AND c.wk + 6)::int AS closed_this_week
FROM ctx c;

-- ── 5. tracker_v_closed_per_week: actions closed per person per ISO week ───
CREATE OR REPLACE VIEW tracker_v_closed_per_week WITH (security_invoker = true) AS
SELECT a.group_id, a.assignee_id AS user_id,
       to_char(a.done_on, 'IYYY-"W"IW') AS iso_week,
       date_trunc('week', a.done_on)::date AS week_start,
       count(*)::int AS closed
FROM tracker_actions a
LEFT JOIN tracker_project_plans p ON p.id = a.plan_id
WHERE a.status = 'done' AND a.done_on IS NOT NULL AND a.assignee_id IS NOT NULL
  AND a.archived_at IS NULL AND (a.plan_id IS NULL OR p.archived_at IS NULL)
GROUP BY a.group_id, a.assignee_id, to_char(a.done_on, 'IYYY-"W"IW'), date_trunc('week', a.done_on)::date;

-- ── 6. tracker_v_health_checks: the five weekly-review checks, per person ──
CREATE OR REPLACE VIEW tracker_v_health_checks WITH (security_invoker = true) AS
WITH live_actions AS (
  SELECT a.* FROM tracker_actions a
  LEFT JOIN tracker_project_plans p ON p.id = a.plan_id
  WHERE a.archived_at IS NULL AND (a.plan_id IS NULL OR p.archived_at IS NULL)
),
people AS (
  SELECT group_id, assignee_id AS user_id FROM live_actions WHERE assignee_id IS NOT NULL
  UNION SELECT group_id, owner_id FROM tracker_project_plans WHERE archived_at IS NULL
  UNION SELECT group_id, lead_id FROM tracker_project_plans WHERE archived_at IS NULL AND lead_id IS NOT NULL
),
ctx AS (
  SELECT pe.group_id, pe.user_id, tracker_today(pe.group_id) AS today,
         COALESCE(s.chaser_days, 5) AS chaser_days
  FROM people pe LEFT JOIN tracker_settings s ON s.group_id = pe.group_id
),
mine AS (
  SELECT c.group_id, c.user_id,
    COALESCE((SELECT array_agg(pa.plan_id ORDER BY pa.plan_id) FROM tracker_v_plan_attention pa
      WHERE pa.group_id = c.group_id AND (pa.owner_id = c.user_id OR pa.lead_id = c.user_id)
      AND pa.flag_no_open_action), '{}') AS no_next_action_ids,
    COALESCE((SELECT array_agg(a.id ORDER BY a.id) FROM live_actions a
      WHERE a.group_id = c.group_id AND a.assignee_id = c.user_id AND a.status = 'waiting'
      AND a.waiting_since IS NOT NULL AND c.today - a.waiting_since > c.chaser_days), '{}') AS waiting_too_long_ids,
    COALESCE((SELECT array_agg(pa.plan_id ORDER BY pa.plan_id) FROM tracker_v_plan_attention pa
      WHERE pa.group_id = c.group_id AND (pa.owner_id = c.user_id OR pa.lead_id = c.user_id)
      AND pa.is_active AND pa.status = 'needs_status_check'), '{}') AS needs_status_check_ids,
    COALESCE((SELECT array_agg(pa.plan_id ORDER BY pa.plan_id) FROM tracker_v_plan_attention pa
      WHERE pa.group_id = c.group_id AND (pa.owner_id = c.user_id OR pa.lead_id = c.user_id)
      AND pa.flag_stale), '{}') AS no_recent_update_ids,
    COALESCE((SELECT array_agg(a.id ORDER BY a.id) FROM live_actions a
      WHERE a.group_id = c.group_id AND a.assignee_id = c.user_id AND a.status = 'open'
      AND a.due_on IS NULL), '{}') AS no_due_date_ids
  FROM ctx c
)
SELECT group_id, user_id,
  cardinality(no_next_action_ids)     AS no_next_action,      no_next_action_ids,
  cardinality(waiting_too_long_ids)   AS waiting_too_long,    waiting_too_long_ids,
  cardinality(needs_status_check_ids) AS needs_status_check,  needs_status_check_ids,
  cardinality(no_recent_update_ids)   AS no_recent_update,    no_recent_update_ids,
  cardinality(no_due_date_ids)        AS no_due_date,         no_due_date_ids
FROM mine;
