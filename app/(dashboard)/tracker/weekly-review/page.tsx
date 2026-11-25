import { redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import { getTrackerContext, getTrackerHeaderData } from '@/lib/tracker/server'
import TrackerHeader from '@/components/tracker/TrackerHeader'
import WeeklyReview, {
  type ReviewStep,
  type SavedReview,
  type ClosedWeek,
  type ClosedAction,
  type HealthCheckRow,
} from '@/components/tracker/WeeklyReview'
import { buildLookups, activeOptions, type LookupRow } from '@/lib/tracker/view'
import { isoWeek, addDays, DEFAULT_SETTINGS } from '@/lib/tracker/domain'

export const dynamic = 'force-dynamic'

/**
 * Weekly review (FR-6).
 * ──────────────────────────────────────────────────────────────────────────
 * A private, personal weekly check-in for the signed-in user: a checklist (the
 * group's review steps, in order), a top three for next week, notes, an 8-week
 * chart of actions I closed, and the five health checks on my projects and
 * actions.
 *
 * Everything is scoped to me by the database (migration 082 RLS): my reviews
 * (tracker_reviews) are readable and writable only by me, and the per-person
 * views (tracker_v_closed_per_week, tracker_v_health_checks) return only my
 * rows. The counts come straight from those views so they match the rest of
 * the tracker; the chart drill-down and the health-check item labels are
 * resolved from the raw action/plan rows the viewer may already see.
 *
 * The reads don't depend on each other, so they run at the same time.
 */
export default async function WeeklyReviewPage() {
  noStore()
  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')
  const { supabase, groupId, userId } = ctx

  const [
    header,
    { data: settingsRow },
    { data: todayVal },
    { data: lookupRows },
    { data: reviewRows },
    { data: closedWeekRows },
    { data: doneActionRows },
    { data: healthRow },
    { data: planRows },
  ] = await Promise.all([
    getTrackerHeaderData(ctx),
    supabase
      .from('tracker_settings')
      .select('chaser_days, stale_days, review_day, week_start, time_zone')
      .eq('group_id', groupId)
      .maybeSingle(),
    supabase.rpc('tracker_today', { p_group_id: groupId }),
    // The group's review steps (and any other lookup lists we might need).
    supabase
      .from('tracker_lookups')
      .select('list, key, label, colour, sort_order, active')
      .eq('group_id', groupId),
    // My saved reviews, every week (RLS: only mine). Small per person.
    supabase
      .from('tracker_reviews')
      .select('iso_week, checks, top3, notes')
      .eq('group_id', groupId)
      .eq('user_id', userId),
    // Actions closed per ISO week — the authoritative counts, for me.
    supabase
      .from('tracker_v_closed_per_week')
      .select('iso_week, closed')
      .eq('group_id', groupId)
      .eq('user_id', userId),
    // My done actions (for the chart drill-down: title + project per week).
    supabase
      .from('tracker_actions')
      .select('id, title, done_on, plan_id, archived_at')
      .eq('group_id', groupId)
      .eq('assignee_id', userId)
      .eq('status', 'done')
      .not('done_on', 'is', null)
      .is('archived_at', null),
    // The five health checks for me, with the ids of the offending items.
    supabase
      .from('tracker_v_health_checks')
      .select(
        'no_next_action, no_next_action_ids, waiting_too_long, waiting_too_long_ids, needs_status_check, needs_status_check_ids, no_recent_update, no_recent_update_ids, no_due_date, no_due_date_ids',
      )
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .maybeSingle(),
    // Plans (for names + archived filter on the drill-down) — RLS-scoped.
    supabase
      .from('tracker_project_plans')
      .select('id, name, archived_at')
      .eq('group_id', groupId),
  ])

  const today = typeof todayVal === 'string' ? todayVal : new Date().toISOString().slice(0, 10)
  const weekStart = (settingsRow?.week_start as 'monday' | 'sunday' | null) ?? DEFAULT_SETTINGS.weekStart
  const reviewDay = (settingsRow?.review_day as string | null) ?? 'friday'
  const staleDays =
    typeof settingsRow?.stale_days === 'number' ? (settingsRow.stale_days as number) : DEFAULT_SETTINGS.staleDays
  const chaserDays =
    typeof settingsRow?.chaser_days === 'number' ? (settingsRow.chaser_days as number) : DEFAULT_SETTINGS.chaserDays

  // Review steps: the shown values of the group's review_step list, in order.
  const lookups = buildLookups((lookupRows ?? []) as LookupRow[])
  const steps: ReviewStep[] = activeOptions(lookups, 'review_step')

  // My saved reviews, keyed by week on the client.
  const savedReviews: SavedReview[] = (reviewRows ?? []).map((r) => ({
    isoWeek: r.iso_week as string,
    checks:
      r.checks && typeof r.checks === 'object' && !Array.isArray(r.checks)
        ? (r.checks as Record<string, boolean>)
        : {},
    top3: (r.top3 as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
  }))

  // Plan name + live set for labels and the drill-down.
  const planNameById = new Map<string, string>()
  const livePlanIds = new Set<string>()
  for (const p of planRows ?? []) {
    planNameById.set(p.id as string, (p.name as string) ?? '')
    if ((p.archived_at as string | null) == null) livePlanIds.add(p.id as string)
  }

  // Chart: the last 8 ISO weeks up to today. The counts come from the view; any
  // week with no closed actions shows 0.
  const closedByWeek = new Map<string, number>()
  for (const r of closedWeekRows ?? []) {
    closedByWeek.set(r.iso_week as string, (r.closed as number) ?? 0)
  }
  const closedWeeks: ClosedWeek[] = []
  for (let i = 7; i >= 0; i--) {
    const w = isoWeek(addDays(today, -7 * i))
    closedWeeks.push({ isoWeek: w, closed: closedByWeek.get(w) ?? 0 })
  }

  // Drill-down: my done actions, title + project (dropping actions on archived
  // plans to match the view).
  const closedActions: ClosedAction[] = (doneActionRows ?? [])
    .filter((a) => {
      const planId = a.plan_id as string | null
      return planId == null || livePlanIds.has(planId)
    })
    .map((a) => {
      const planId = (a.plan_id as string | null) ?? null
      return {
        id: a.id as string,
        title: (a.title as string) ?? '',
        doneOn: a.done_on as string,
        planId,
        planName: planId ? planNameById.get(planId) ?? null : null,
      }
    })

  // Action titles for the action-based health checks (waiting too long, no due
  // date). Load titles for just the ids involved.
  const waitingIds = (healthRow?.waiting_too_long_ids as string[] | null) ?? []
  const noDueIds = (healthRow?.no_due_date_ids as string[] | null) ?? []
  const actionIds = Array.from(new Set([...waitingIds, ...noDueIds]))
  const actionTitleById = new Map<string, { title: string; planId: string | null }>()
  if (actionIds.length > 0) {
    const { data: actionRows } = await supabase
      .from('tracker_actions')
      .select('id, title, plan_id')
      .in('id', actionIds)
    for (const a of actionRows ?? []) {
      actionTitleById.set(a.id as string, {
        title: (a.title as string) ?? '',
        planId: (a.plan_id as string | null) ?? null,
      })
    }
  }

  const planItem = (id: string) => ({
    id,
    label: planNameById.get(id) ?? 'Project',
    href: `/tracker/plans/${id}`,
  })
  const actionItem = (id: string) => {
    const a = actionTitleById.get(id)
    return {
      id,
      label: a?.title ?? 'Action',
      href: a?.planId ? `/tracker/plans/${a.planId}` : null,
    }
  }

  const noUpdateLabel = `Plans with no update in ${staleDays} days`

  const healthChecks: HealthCheckRow[] = [
    {
      key: 'noNextAction',
      label: 'Active plans with no next action',
      count: (healthRow?.no_next_action as number | null) ?? 0,
      items: ((healthRow?.no_next_action_ids as string[] | null) ?? []).map(planItem),
    },
    {
      key: 'waitingTooLong',
      label: `Actions waiting over ${chaserDays} days`,
      count: (healthRow?.waiting_too_long as number | null) ?? 0,
      items: waitingIds.map(actionItem),
    },
    {
      key: 'needsStatusCheck',
      label: 'Plans needing a status check',
      count: (healthRow?.needs_status_check as number | null) ?? 0,
      items: ((healthRow?.needs_status_check_ids as string[] | null) ?? []).map(planItem),
    },
    {
      key: 'noRecentUpdate',
      label: noUpdateLabel,
      count: (healthRow?.no_recent_update as number | null) ?? 0,
      items: ((healthRow?.no_recent_update_ids as string[] | null) ?? []).map(planItem),
    },
    {
      key: 'noDueDate',
      label: 'Open actions without a date',
      count: (healthRow?.no_due_date as number | null) ?? 0,
      items: noDueIds.map(actionItem),
    },
  ]

  const thisWeek = isoWeek(today)

  return (
    <>
      <TrackerHeader
        groupName="Your review · only you can see it · saved automatically"
        title={`Weekly review · ${thisWeek}`}
        showSettings={header.showSettings}
      />
      <WeeklyReview
        today={today}
        weekStart={weekStart}
        reviewDay={reviewDay}
        steps={steps}
        savedReviews={savedReviews}
        closedWeeks={closedWeeks}
        closedActions={closedActions}
        healthChecks={healthChecks}
      />
    </>
  )
}
