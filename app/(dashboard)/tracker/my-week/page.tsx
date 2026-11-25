import { redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import { getTrackerContext, getTrackerHeaderData } from '@/lib/tracker/server'
import TrackerHeader from '@/components/tracker/TrackerHeader'
import MyWeek, {
  type MyWeekAction,
  type MyWeekGroups,
  type MyWeekTiles,
  type CallContact,
  type CallContactProject,
} from '@/components/tracker/MyWeek'
import { buildLookups, lookupLabel, daysBetweenISO, type LookupRow } from '@/lib/tracker/view'
import {
  myWeek,
  DEFAULT_SETTINGS,
  type Action,
  type Plan,
  type TrackerSettings,
} from '@/lib/tracker/domain'

export const dynamic = 'force-dynamic'

/**
 * My week (FR-4.4, FR-4.5).
 * ──────────────────────────────────────────────────────────────────────────
 * Everything assigned to the signed-in user, sorted by when it's due. The six
 * tiles come straight from the database view tracker_v_action_counts (so they
 * match the rest of the tracker). The grouped list and the side columns use the
 * shared myWeek() rule in lib/tracker/domain.ts over the raw action/plan rows
 * (RLS-scoped to the group), so they never drift from the counts.
 *
 * Archived plans/actions, actions assigned to other people and actions from the
 * user's other groups never appear: the query is scoped to the active group and
 * assignee, and myWeek()/liveActions() drop archived rows and rows on archived
 * plans.
 */
export default async function MyWeekPage() {
  noStore()
  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')
  const { supabase, groupId, userId } = ctx

  // None of these reads depend on each other, so run them at the same time
  // (Promise.all) rather than one after another — this is what makes My week
  // open quickly.
  const [
    header,
    { data: settingsRow },
    { data: todayVal },
    { data: lookupRows },
    { data: countsRow },
    { data: planRows },
    { data: actionRows },
    { data: contactRows },
    { data: contactLinkRows },
    { data: myActionPlanRows },
  ] = await Promise.all([
    getTrackerHeaderData(ctx),
    // Group settings (chaser days, follow-up days, time zone, week start) with
    // the shared defaults.
    supabase
      .from('tracker_settings')
      .select('chaser_days, stale_days, contact_followup_days, week_start, time_zone')
      .eq('group_id', groupId)
      .maybeSingle(),
    // Today in the group's time zone (same helper the views use), so the list
    // buckets match the tile counts.
    supabase.rpc('tracker_today', { p_group_id: groupId }),
    // Lookups for action type labels. Load BOTH shown and hidden values so
    // existing actions keep their type label even after a type is hidden.
    supabase
      .from('tracker_lookups')
      .select('list, key, label, colour, sort_order, active')
      .eq('group_id', groupId),
    // Tiles: straight from the database view, for this person in this group.
    supabase
      .from('tracker_v_action_counts')
      .select(
        'overdue, due_this_week, waiting_on_others, calls_and_emails, plans_needing_attention, closed_this_week',
      )
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .maybeSingle(),
    // Raw rows for the shared myWeek() rule. RLS scopes these to the group; the
    // rule drops archived rows and rows on archived plans, and keeps only this
    // user's actions.
    supabase
      .from('tracker_project_plans')
      .select('id, name, parent_id, status, owner_id, lead_id, updated_on, archived_at')
      .eq('group_id', groupId),
    supabase
      .from('tracker_actions')
      .select(
        'id, plan_id, milestone_id, title, type, who, assignee_id, due_on, status, waiting_since, done_on, created_on, archived_at',
      )
      .eq('group_id', groupId)
      .eq('assignee_id', userId),
    // External contacts (non-archived) and their plan links — used to surface,
    // in "Calls to make", contacts on the user's own projects not spoken to for
    // the follow-up window (or ever). RLS scopes these to what the user sees.
    supabase
      .from('tracker_contacts')
      .select('id, name, org, last_contact')
      .eq('group_id', groupId)
      .is('archived_at', null),
    supabase.from('tracker_contact_plans').select('contact_id, plan_id').eq('group_id', groupId),
    // Names of the projects behind my own actions (migration 086). An assignee
    // may be given an action on a project they can't otherwise see, so the
    // RLS-scoped plan rows above won't name it. This SECURITY DEFINER function
    // returns id + name for every project where I'm assigned a live action, so
    // each action can still show its project's name.
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

  const tiles: MyWeekTiles = {
    overdue: (countsRow?.overdue as number | null) ?? 0,
    dueThisWeek: (countsRow?.due_this_week as number | null) ?? 0,
    waitingOnOthers: (countsRow?.waiting_on_others as number | null) ?? 0,
    callsAndEmails: (countsRow?.calls_and_emails as number | null) ?? 0,
    plansNeedingAttention: (countsRow?.plans_needing_attention as number | null) ?? 0,
    closedThisWeek: (countsRow?.closed_this_week as number | null) ?? 0,
  }

  // Plan ids the user can actually open (RLS-scoped) — used to decide whether a
  // project name becomes a link.
  const visiblePlanIds = new Set<string>()
  for (const p of planRows ?? []) visiblePlanIds.add(p.id as string)

  const planNameById = new Map<string, string>()
  for (const p of planRows ?? []) planNameById.set(p.id as string, (p.name as string) ?? '')
  // Overlay names for projects behind my actions that I can't otherwise see, so
  // each action still shows which project it belongs to.
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

  // "who" (free-text counterparty) isn't carried by the domain Action type;
  // keep a side lookup so the cards can show "with {who}".
  const whoById = new Map<string, string | null>()
  for (const a of actionRows ?? []) whoById.set(a.id as string, (a.who as string | null) ?? null)

  const week = myWeek(actions, plans, userId, today, settings)

  const toView = (a: Action): MyWeekAction => ({
    id: a.id,
    title: a.title,
    type: a.type,
    typeLabel: lookupLabel(lookups, 'action_type', a.type),
    planId: a.planId,
    planName: a.planId ? planNameById.get(a.planId) ?? null : null,
    // Only link to the project when the user can actually open it (migration
    // 086): an assignee may have an action on a project they can't see.
    planLinkable: a.planId ? visiblePlanIds.has(a.planId) : false,
    dueOn: a.dueOn,
    status: a.status,
    who: whoById.get(a.id) ?? null,
    // My week shows the user's own actions, so the counterparty is the
    // free-text "who"; there is no separate assignee to name here.
    assigneeName: null,
    waitingSince: a.waitingSince,
  })

  const groups: MyWeekGroups = {
    overdue: week.overdue.map(toView),
    today: week.today.map(toView),
    restOfWeek: week.restOfWeek.map(toView),
    nextWeek: week.nextWeek.map(toView),
    later: week.later.map(toView),
    noDate: week.noDate.map(toView),
    waiting: week.waiting.map(toView),
    calls: week.calls.map(toView),
  }

  // "Calls to make" also lists the user's own external contacts (on live
  // projects they own or lead) not spoken to for the follow-up window, or ever.
  const followUpDays =
    typeof settingsRow?.contact_followup_days === 'number'
      ? (settingsRow.contact_followup_days as number)
      : 21

  // Live projects (not archived) the user owns or leads → the "+ Call" target.
  const myProjectIds = new Set(
    (planRows ?? [])
      .filter(
        (p) =>
          (p.archived_at as string | null) == null &&
          ((p.owner_id as string) === userId || (p.lead_id as string | null) === userId),
      )
      .map((p) => p.id as string),
  )

  // Contact → the user's projects it's linked to.
  const myProjectsByContact = new Map<string, CallContactProject[]>()
  for (const l of contactLinkRows ?? []) {
    const planId = l.plan_id as string
    if (!myProjectIds.has(planId)) continue
    const list = myProjectsByContact.get(l.contact_id as string) ?? []
    list.push({ id: planId, name: planNameById.get(planId) ?? '' })
    myProjectsByContact.set(l.contact_id as string, list)
  }

  const callContacts: CallContact[] = (contactRows ?? [])
    .map((c) => ({
      id: c.id as string,
      name: c.name as string,
      org: (c.org as string | null) ?? null,
      lastContact: (c.last_contact as string | null) ?? null,
      projects: myProjectsByContact.get(c.id as string) ?? [],
    }))
    // Only contacts on one of the user's projects, and only those overdue.
    .filter((c) => c.projects.length > 0)
    .filter((c) => c.lastContact == null || daysBetweenISO(c.lastContact, today) >= followUpDays)
    .sort((a, b) => a.name.localeCompare(b.name))

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
        title="My week"
        showSettings={header.showSettings}
      />
      <MyWeek
        tiles={tiles}
        groups={groups}
        today={today}
        chaserDays={settings.chaserDays}
        followUpDays={followUpDays}
        callContacts={callContacts}
        currentUserId={userId}
      />
    </>
  )
}
