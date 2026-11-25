import { redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import { getTrackerContext, getTrackerHeaderData, isEditor } from '@/lib/tracker/server'
import TrackerHeader from '@/components/tracker/TrackerHeader'
import MySummary, {
  type SummaryItem,
  type SummaryGroups,
  type SummaryTilesView,
  type BandBounds,
} from '@/components/tracker/MySummary'
import { buildLookups, lookupLabel, type LookupRow } from '@/lib/tracker/view'
import {
  mySummary,
  summaryTiles,
  dateBandBounds,
  myEditablePlanIds,
  DEFAULT_SETTINGS,
  type Action,
  type Plan,
  type PlanUpdate,
  type TrackerSettings,
} from '@/lib/tracker/domain'

export const dynamic = 'force-dynamic'

/**
 * My Summary (reworked from My week).
 * ──────────────────────────────────────────────────────────────────────────
 * A summary of the signed-in person's open items: open actions on their
 * projects (owner, lead, member or Comment/Edit access — sub-projects count if
 * they're on the parent) PLUS open actions assigned to them on any other
 * project. Grouped into working-day date bands (Overdue, Next 7, 8–14, 15–30,
 * No date). Items due after working day 30 aren't shown.
 *
 * The tiles, the list bands and who may use the quick buttons all come from the
 * shared rules in lib/tracker/domain.ts over the RLS-scoped rows, so the tiles
 * and the list always agree and staff only ever see their own projects. The
 * page address stays /tracker/my-week for backward compatibility.
 *
 * Reads that don't depend on each other run together (Promise.all).
 */
export default async function MySummaryPage() {
  noStore()
  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')
  const { supabase, groupId, userId } = ctx

  const [
    header,
    editor,
    { data: settingsRow },
    { data: todayVal },
    { data: lookupRows },
    { data: planRows },
    { data: actionRows },
    { data: updateRows },
    { data: memberRows },
    { data: shareRows },
    { data: myActionPlanRows },
  ] = await Promise.all([
    getTrackerHeaderData(ctx),
    isEditor(supabase, groupId),
    supabase
      .from('tracker_settings')
      .select('chaser_days, stale_days, week_start, time_zone')
      .eq('group_id', groupId)
      .maybeSingle(),
    supabase.rpc('tracker_today', { p_group_id: groupId }),
    supabase
      .from('tracker_lookups')
      .select('list, key, label, colour, sort_order, active')
      .eq('group_id', groupId),
    // Plans the reader can see (RLS-scoped to the group). The access rules
    // decide visibility; the shared rule then keeps only "my" projects + items.
    supabase
      .from('tracker_project_plans')
      .select('id, name, parent_id, status, owner_id, lead_id, updated_on, archived_at')
      .eq('group_id', groupId),
    // All actions the reader can see in the group (whoever they're assigned to).
    // RLS scopes this to projects the reader may read; mySummary() narrows to
    // open items on my projects plus items assigned to me.
    supabase
      .from('tracker_actions')
      .select(
        'id, plan_id, milestone_id, title, type, who, assignee_id, due_on, status, waiting_since, done_on, created_on, archived_at',
      )
      .eq('group_id', groupId),
    // Plan updates feed the "projects needing attention" tile (last-updated).
    supabase.from('tracker_updates').select('plan_id, date').eq('group_id', groupId),
    // My membership and share rows, to decide which projects are "mine".
    supabase.from('tracker_plan_members').select('plan_id, role').eq('user_id', userId),
    supabase.from('tracker_plan_shares').select('plan_id, level').eq('user_id', userId),
    // Names of the projects behind my own actions on projects I can't otherwise
    // see (SECURITY DEFINER), so each such action still shows its project name.
    supabase.rpc('tracker_my_action_plans', { p_group_id: groupId }),
  ])

  const settings: TrackerSettings = {
    chaserDays:
      typeof settingsRow?.chaser_days === 'number' ? (settingsRow.chaser_days as number) : DEFAULT_SETTINGS.chaserDays,
    staleDays:
      typeof settingsRow?.stale_days === 'number' ? (settingsRow.stale_days as number) : DEFAULT_SETTINGS.staleDays,
    weekStart: (settingsRow?.week_start as 'monday' | 'sunday' | null) ?? DEFAULT_SETTINGS.weekStart,
    timeZone: (settingsRow?.time_zone as string | null) ?? DEFAULT_SETTINGS.timeZone,
  }

  const today = typeof todayVal === 'string' ? todayVal : new Date().toISOString().slice(0, 10)
  const lookups = buildLookups((lookupRows ?? []) as LookupRow[])

  // Plan ids the user can actually open (RLS-scoped) — decides whether a
  // project name becomes a link.
  const visiblePlanIds = new Set<string>()
  const planNameById = new Map<string, string>()
  const planStatusById = new Map<string, string | null>()
  for (const p of planRows ?? []) {
    visiblePlanIds.add(p.id as string)
    planNameById.set(p.id as string, (p.name as string) ?? '')
    planStatusById.set(p.id as string, (p.status as string | null) ?? null)
  }
  for (const p of (myActionPlanRows ?? []) as { id: string; name: string }[]) {
    if (!planNameById.has(p.id)) planNameById.set(p.id, p.name ?? '')
  }

  const plans: Plan[] = (planRows ?? []).map((p) => ({
    id: p.id as string,
    parentId: (p.parent_id as string | null) ?? null,
    status: (p.status as string | null) ?? null,
    ownerId: (p.owner_id as string) ?? '',
    leadId: (p.lead_id as string | null) ?? null,
    updatedOn: (p.updated_on as string) ?? today,
    archivedAt: (p.archived_at as string | null) ?? null,
  }))

  const actions: Action[] = (actionRows ?? []).map((a) => ({
    id: a.id as string,
    planId: (a.plan_id as string | null) ?? null,
    milestoneId: (a.milestone_id as string | null) ?? null,
    title: (a.title as string) ?? '',
    type: (a.type as string | null) ?? null,
    assigneeId: (a.assignee_id as string | null) ?? null,
    dueOn: (a.due_on as string | null) ?? null,
    status: (a.status as Action['status']) ?? 'open',
    waitingSince: (a.waiting_since as string | null) ?? null,
    doneOn: (a.done_on as string | null) ?? null,
    createdOn: (a.created_on as string) ?? today,
    archivedAt: (a.archived_at as string | null) ?? null,
  }))

  const updates: PlanUpdate[] = (updateRows ?? []).map((u) => ({
    planId: u.plan_id as string,
    date: u.date as string,
  }))

  // Free-text counterparty ("with {who}") — not carried by the domain Action.
  const whoById = new Map<string, string | null>()
  for (const a of actionRows ?? []) whoById.set(a.id as string, (a.who as string | null) ?? null)

  // My access: membership and Comment/Edit shares.
  const memberPlanIds = (memberRows ?? []).map((r) => r.plan_id as string)
  const sharedPlanIds = (shareRows ?? []).map((r) => r.plan_id as string)
  const editSharePlanIds = (shareRows ?? [])
    .filter((r) => (r.level as string) === 'edit')
    .map((r) => r.plan_id as string)
  const access = { memberPlanIds, sharedPlanIds, editSharePlanIds }

  const summary = mySummary(actions, plans, userId, today, access)
  const tiles: SummaryTilesView = summaryTiles(plans, actions, updates, userId, today, settings, access)

  // Plans whose actions this person may act on with the quick buttons: projects
  // they own/lead/have-edit-share on (and sub-projects). Managers / Group
  // Owners may act on everything (editor); an action's own assignee may always
  // act on it.
  const editablePlanIds = myEditablePlanIds(plans, userId, access)
  const canActOn = (a: Action): boolean => {
    if (a.assigneeId === userId) return true
    if (editor) return true
    return a.planId !== null && editablePlanIds.has(a.planId)
  }

  const toView = (a: Action): SummaryItem => ({
    id: a.id,
    title: a.title,
    type: a.type,
    typeLabel: lookupLabel(lookups, 'action_type', a.type),
    planId: a.planId,
    planName: a.planId ? planNameById.get(a.planId) ?? null : null,
    planStatus: a.planId ? planStatusById.get(a.planId) ?? null : null,
    planLinkable: a.planId ? visiblePlanIds.has(a.planId) : false,
    dueOn: a.dueOn,
    status: a.status,
    who: whoById.get(a.id) ?? null,
    assigneeName: null,
    waitingSince: a.waitingSince,
    canAct: canActOn(a),
  })

  const groups: SummaryGroups = {
    overdue: summary.overdue.map(toView),
    next7: summary.next7.map(toView),
    days8to14: summary.days8to14.map(toView),
    days15to30: summary.days15to30.map(toView),
    noDate: summary.noDate.map(toView),
    waiting: summary.waiting.map(toView),
  }

  const b = dateBandBounds(today)
  const bounds: BandBounds = {
    today,
    dayOne: b.dayOne,
    end7: b.end7,
    end14: b.end14,
    end30: b.end30,
  }

  // The group's day and date in its time zone, e.g. "Monday, 3 Jun 2026".
  const dayAndDate = new Intl.DateTimeFormat('en-GB', {
    timeZone: settings.timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date())

  return (
    <>
      <TrackerHeader
        groupName={header.groupName ? `${header.groupName} · ${dayAndDate}` : dayAndDate}
        title="My Summary"
        showSettings={header.showSettings}
      />
      <MySummary tiles={tiles} groups={groups} bounds={bounds} today={today} chaserDays={settings.chaserDays} />
    </>
  )
}
