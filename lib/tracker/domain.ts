/**
 * Project Tracker business rules (P3).
 * ──────────────────────────────────────────────────────────────────────────
 * The one place the tracker's rules live (SRS NFR-9): needs attention, the
 * waiting chaser, milestone progress, week maths, My week groups and tiles,
 * closed per week and the weekly-review health checks. Pure functions, no
 * imports, no database: the screens pass in rows they already loaded.
 *
 * The SQL views in supabase/migrations/083_tracker_views.sql compute the same
 * numbers in the database; lib/tracker/domain.test.ts and
 * supabase/tests/083_tracker_views_test.sql check both against one fixture.
 * Change a rule in both places, or the tests fail.
 *
 * Dates are 'YYYY-MM-DD' strings in the group's time zone.
 */

export type ISODate = string

export type TrackerSettings = {
  chaserDays: number
  staleDays: number
  weekStart: 'monday' | 'sunday'
  timeZone: string
}

export const DEFAULT_SETTINGS: TrackerSettings = {
  chaserDays: 5,
  staleDays: 21,
  weekStart: 'monday',
  timeZone: 'Australia/Perth',
}

export type Plan = {
  id: string
  parentId: string | null
  status: string | null
  ownerId: string
  leadId: string | null
  updatedOn: ISODate
  archivedAt: string | null
}

export type ActionStatus = 'open' | 'waiting' | 'done'

export type Action = {
  id: string
  planId: string | null
  milestoneId: string | null
  title: string
  type: string | null
  assigneeId: string | null
  dueOn: ISODate | null
  status: ActionStatus
  waitingSince: ISODate | null
  doneOn: ISODate | null
  createdOn: ISODate
  archivedAt: string | null
}

export type PlanUpdate = { planId: string; date: ISODate }

export type Milestone = {
  id: string
  planId: string
  status: string
  dueOn: ISODate | null
  baselineDueOn: ISODate | null
  progressMode: 'manual' | 'from_actions'
  progressPct: number
  archivedAt: string | null
}

// ── Dates ──────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000

function toUtc(d: ISODate): number {
  const [y, m, day] = d.split('-').map(Number)
  return Date.UTC(y, m - 1, day)
}

function fromUtc(ms: number): ISODate {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Today in a time zone, as 'YYYY-MM-DD'. */
export function todayIn(timeZone: string, now: Date = new Date()): ISODate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

export function addDays(d: ISODate, n: number): ISODate {
  return fromUtc(toUtc(d) + n * DAY_MS)
}

/** b − a in whole days. */
export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS)
}

/** First day of the week containing d. */
export function weekStartOf(d: ISODate, weekStart: 'monday' | 'sunday'): ISODate {
  const dow = new Date(toUtc(d)).getUTCDay() // 0 = Sunday
  const back = weekStart === 'sunday' ? dow : (dow + 6) % 7
  return addDays(d, -back)
}

/** ISO week label, e.g. '2026-W47'. */
export function isoWeek(d: ISODate): string {
  const ms = toUtc(d)
  const isoDow = (new Date(ms).getUTCDay() + 6) % 7 // 0 = Monday
  const thursday = ms + (3 - isoDow) * DAY_MS
  const year = new Date(thursday).getUTCFullYear()
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

// ── Waiting chaser ─────────────────────────────────────────────────────────

/** Due date set when an action is marked Waiting (FR-4.3). */
export function waitingDueDate(today: ISODate, s: TrackerSettings = DEFAULT_SETTINGS): ISODate {
  return addDays(today, s.chaserDays)
}

/** Waiting longer than the chaser days. */
export function isWaitingTooLong(a: Action, today: ISODate, s: TrackerSettings = DEFAULT_SETTINGS): boolean {
  return a.status === 'waiting' && a.waitingSince !== null && daysBetween(a.waitingSince, today) > s.chaserDays
}

// ── Shared helpers ─────────────────────────────────────────────────────────

const ATTENTION_STATUSES = ['at_risk', 'blocked', 'needs_status_check']

/** Actions that count: not archived, and not on an archived or missing plan. */
export function liveActions(actions: Action[], plans: Plan[]): Action[] {
  const livePlans = new Set(plans.filter((p) => p.archivedAt === null).map((p) => p.id))
  return actions.filter((a) => a.archivedAt === null && (a.planId === null || livePlans.has(a.planId)))
}

function byNextAction(a: Action, b: Action): number {
  if (a.dueOn !== b.dueOn) {
    if (a.dueOn === null) return 1
    if (b.dueOn === null) return -1
    return a.dueOn < b.dueOn ? -1 : 1
  }
  if (a.createdOn !== b.createdOn) return a.createdOn < b.createdOn ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// ── Plan attention (FR-2.4, FR-2.6) ────────────────────────────────────────

export type PlanAttention = {
  planId: string
  isActive: boolean
  lastUpdated: ISODate
  openActions: number
  subPlans: number
  nextAction: Action | null
  flags: { status: boolean; noOpenAction: boolean; overdueAction: boolean; stale: boolean }
  needsAttention: boolean
}

export function planAttention(
  plans: Plan[], actions: Action[], updates: PlanUpdate[],
  today: ISODate, s: TrackerSettings = DEFAULT_SETTINGS,
): Map<string, PlanAttention> {
  const live = plans.filter((p) => p.archivedAt === null)
  const children = new Map<string, string[]>()
  for (const p of live) {
    if (p.parentId !== null) children.set(p.parentId, [...(children.get(p.parentId) ?? []), p.id])
  }
  const acts = actions.filter((a) => a.archivedAt === null)
  const result = new Map<string, PlanAttention>()
  for (const p of live) {
    const ids = new Set<string>()
    const walk = (id: string, depth: number) => {
      ids.add(id)
      if (depth >= 20) return
      for (const c of children.get(id) ?? []) walk(c, depth + 1)
    }
    walk(p.id, 0)
    const mine = acts.filter((a) => a.planId !== null && ids.has(a.planId))
    const open = mine.filter((a) => a.status === 'open' || a.status === 'waiting')
    const hasOverdue = mine.some((a) => a.status === 'open' && a.dueOn !== null && a.dueOn < today)
    const newestUpdate = updates.filter((u) => u.planId === p.id).map((u) => u.date).sort().pop()
    const lastUpdated = newestUpdate && newestUpdate > p.updatedOn ? newestUpdate : p.updatedOn
    const isActive = p.status !== 'finished'
    const flags = {
      status: isActive && p.status !== null && ATTENTION_STATUSES.includes(p.status),
      noOpenAction: isActive && open.length === 0,
      overdueAction: isActive && hasOverdue,
      stale: isActive && daysBetween(lastUpdated, today) >= s.staleDays,
    }
    result.set(p.id, {
      planId: p.id,
      isActive,
      lastUpdated,
      openActions: open.length,
      subPlans: (children.get(p.id) ?? []).length,
      nextAction: mine.filter((a) => a.status === 'open').sort(byNextAction)[0] ?? null,
      flags,
      needsAttention: flags.status || flags.noOpenAction || flags.overdueAction || flags.stale,
    })
  }
  return result
}

// ── Milestone progress (FR-3.3, FR-3.4) ────────────────────────────────────

export type MilestoneProgress = {
  milestoneId: string
  doneActions: number
  totalActions: number
  progressPct: number
  daysSlipped: number | null
  overdue: boolean
}

export function milestoneProgress(m: Milestone, actions: Action[], today: ISODate): MilestoneProgress {
  const linked = actions.filter((a) => a.milestoneId === m.id && a.archivedAt === null)
  const done = linked.filter((a) => a.status === 'done').length
  const progressPct = m.progressMode === 'from_actions'
    ? (linked.length === 0 ? 0 : Math.round((100 * done) / linked.length))
    : m.progressPct
  return {
    milestoneId: m.id,
    doneActions: done,
    totalActions: linked.length,
    progressPct,
    daysSlipped: m.dueOn !== null && m.baselineDueOn !== null ? daysBetween(m.baselineDueOn, m.dueOn) : null,
    overdue: m.dueOn !== null && m.dueOn < today && m.status !== 'completed' && m.status !== 'cancelled',
  }
}

// ── My week (FR-4.4, FR-4.5) ───────────────────────────────────────────────

export type MyWeek = {
  overdue: Action[]
  today: Action[]
  restOfWeek: Action[]
  nextWeek: Action[]
  later: Action[]
  noDate: Action[]
  waiting: Action[]
  calls: Action[]
}

export function myWeek(
  actions: Action[], plans: Plan[], userId: string,
  today: ISODate, s: TrackerSettings = DEFAULT_SETTINGS,
): MyWeek {
  const weekEnd = addDays(weekStartOf(today, s.weekStart), 6)
  const nextWeekEnd = addDays(weekEnd, 7)
  const mine = liveActions(actions, plans).filter((a) => a.assigneeId === userId).sort(byNextAction)
  const open = mine.filter((a) => a.status === 'open')
  return {
    overdue: open.filter((a) => a.dueOn !== null && a.dueOn < today),
    today: open.filter((a) => a.dueOn === today),
    restOfWeek: open.filter((a) => a.dueOn !== null && a.dueOn > today && a.dueOn <= weekEnd),
    nextWeek: open.filter((a) => a.dueOn !== null && a.dueOn > weekEnd && a.dueOn <= nextWeekEnd),
    later: open.filter((a) => a.dueOn !== null && a.dueOn > nextWeekEnd),
    noDate: open.filter((a) => a.dueOn === null),
    waiting: mine.filter((a) => a.status === 'waiting'),
    calls: open.filter((a) => a.type === 'call'),
  }
}

// ── My Summary (working-day date bands + access rules) ──────────────────────
//
// "My Summary" (the reworked My week) shows the open items on the signed-in
// person's projects, plus any open items assigned to them on other projects,
// grouped into working-day date bands. The rules live here so the tiles and the
// list always agree. Working days are Monday–Friday in the group's time zone;
// "today" is already supplied as a 'YYYY-MM-DD' string in that zone.

/** True when an ISO date falls on a weekend (Saturday or Sunday). */
export function isWeekend(d: ISODate): boolean {
  const dow = new Date(toUtc(d)).getUTCDay() // 0 = Sun … 6 = Sat
  return dow === 0 || dow === 6
}

/**
 * "Working day 1" — today if today is a weekday, otherwise the next Monday.
 * The date bands are measured forward from here.
 */
export function workingDayOne(today: ISODate): ISODate {
  let d = today
  while (isWeekend(d)) d = addDays(d, 1)
  return d
}

/**
 * The inclusive end date of a run of `n` working days starting at `from`
 * (which must itself be a weekday). Walks forward counting only Mon–Fri, so
 * the band spans any weekends in between.
 *
 * nthWorkingDay(from, 1) === from; nthWorkingDay(from, 7) is the 7th working
 * day (the last day of the "next 7 working days" band).
 */
export function nthWorkingDay(from: ISODate, n: number): ISODate {
  let d = from
  let counted = 1 // `from` is working day 1
  while (counted < n) {
    d = addDays(d, 1)
    if (!isWeekend(d)) counted++
  }
  return d
}

export type DateBandKey = 'overdue' | 'next7' | 'days8to14' | 'days15to30' | 'noDate'

export type DateBandBounds = {
  /** Working-day 1 (today or the next Monday). */
  dayOne: ISODate
  /** Last day of the "next 7 working days" band (inclusive). */
  end7: ISODate
  /** Last day of the "working days 8–14" band (inclusive). */
  end14: ISODate
  /** Last day of the "working days 15–30" band (inclusive). */
  end30: ISODate
}

/** The inclusive end dates of the working-day bands, measured from today. */
export function dateBandBounds(today: ISODate): DateBandBounds {
  const dayOne = workingDayOne(today)
  return {
    dayOne,
    end7: nthWorkingDay(dayOne, 7),
    end14: nthWorkingDay(dayOne, 14),
    end30: nthWorkingDay(dayOne, 30),
  }
}

/**
 * Which date band an open action falls in, by its due date, or null when it is
 * past working day 30 (not shown on this page). Undated actions return
 * 'noDate'.
 */
export function dateBandOf(dueOn: ISODate | null, today: ISODate, b?: DateBandBounds): DateBandKey | null {
  if (dueOn === null) return 'noDate'
  const bounds = b ?? dateBandBounds(today)
  if (dueOn < today) return 'overdue'
  if (dueOn <= bounds.end7) return 'next7'
  if (dueOn <= bounds.end14) return 'days8to14'
  if (dueOn <= bounds.end30) return 'days15to30'
  return null // after working day 30 — not shown
}

/** Project access rows the summary needs to decide what counts as "mine". */
export type PlanAccess = {
  /** Non-archived plan ids where I'm a member (tracker_plan_members). */
  memberPlanIds?: Iterable<string>
  /** Plan ids where I have Comment or Edit share (tracker_plan_shares). */
  sharedPlanIds?: Iterable<string>
  /** Plan ids where I have Edit share specifically (for action buttons). */
  editSharePlanIds?: Iterable<string>
}

/**
 * The ids of "my projects": non-archived projects where I'm the owner or lead,
 * in the Members list, or given Comment/Edit access — and every sub-project of
 * one of those (access to a parent includes its sub-projects).
 */
export function myPlanIds(plans: Plan[], userId: string, access: PlanAccess = {}): Set<string> {
  const live = plans.filter((p) => p.archivedAt === null)
  const members = new Set(Array.from(access.memberPlanIds ?? []))
  const shared = new Set(Array.from(access.sharedPlanIds ?? []))

  // Directly "mine": owner, lead, member or shared.
  const direct = new Set<string>()
  for (const p of live) {
    if (p.ownerId === userId || p.leadId === userId || members.has(p.id) || shared.has(p.id)) {
      direct.add(p.id)
    }
  }

  // Inherit down to sub-projects: a project counts if I'm on any ancestor.
  const children = new Map<string, string[]>()
  for (const p of live) {
    if (p.parentId !== null) children.set(p.parentId, [...(children.get(p.parentId) ?? []), p.id])
  }
  const mine = new Set<string>()
  const walk = (id: string, depth: number) => {
    if (mine.has(id)) return
    mine.add(id)
    if (depth >= 20) return
    for (const c of children.get(id) ?? []) walk(c, depth + 1)
  }
  for (const id of Array.from(direct)) walk(id, 0)
  return mine
}

/**
 * Plan ids whose actions I may act on with the quick buttons: projects I own or
 * lead, or where I have an Edit share. (Managers / Group Owners are handled by
 * the caller via an `isEditor` flag; an action's own assignee is always
 * allowed, decided per-action.) Members and Comment access do not grant this.
 */
export function myEditablePlanIds(plans: Plan[], userId: string, access: PlanAccess = {}): Set<string> {
  const live = plans.filter((p) => p.archivedAt === null)
  const editShares = new Set(Array.from(access.editSharePlanIds ?? []))
  const direct = new Set<string>()
  for (const p of live) {
    if (p.ownerId === userId || p.leadId === userId || editShares.has(p.id)) direct.add(p.id)
  }
  const children = new Map<string, string[]>()
  for (const p of live) {
    if (p.parentId !== null) children.set(p.parentId, [...(children.get(p.parentId) ?? []), p.id])
  }
  const out = new Set<string>()
  const walk = (id: string, depth: number) => {
    if (out.has(id)) return
    out.add(id)
    if (depth >= 20) return
    for (const c of children.get(id) ?? []) walk(c, depth + 1)
  }
  for (const id of Array.from(direct)) walk(id, 0)
  return out
}

export type SummaryAction = Action

export type MySummary = {
  /** Open items in each band, sorted by due date (undated last). */
  overdue: SummaryAction[]
  next7: SummaryAction[]
  days8to14: SummaryAction[]
  days15to30: SummaryAction[]
  noDate: SummaryAction[]
  /** My waiting items (any band), sorted by due date. */
  waiting: SummaryAction[]
}

/**
 * "My items": open actions on my projects (whoever they're assigned to, or
 * nobody), PLUS open actions assigned to me on any other project. Grouped into
 * the working-day date bands. Items due after working day 30 are dropped.
 *
 * `plans` are the RLS-scoped plan rows; `access` carries my membership / share
 * ids. Pass the same `today` the page uses so the bands match the tiles.
 */
export function mySummary(
  actions: Action[],
  plans: Plan[],
  userId: string,
  today: ISODate,
  access: PlanAccess = {},
): MySummary {
  const mineProjectIds = myPlanIds(plans, userId, access)
  const live = liveActions(actions, plans)
  // On one of my projects, OR assigned to me anywhere.
  const mine = live
    .filter(
      (a) => (a.planId !== null && mineProjectIds.has(a.planId)) || a.assigneeId === userId,
    )
    .sort(byNextAction)
  const open = mine.filter((a) => a.status === 'open')
  const bounds = dateBandBounds(today)
  const inBand = (key: DateBandKey) => open.filter((a) => dateBandOf(a.dueOn, today, bounds) === key)
  return {
    overdue: inBand('overdue'),
    next7: inBand('next7'),
    days8to14: inBand('days8to14'),
    days15to30: inBand('days15to30'),
    noDate: inBand('noDate'),
    waiting: mine.filter((a) => a.status === 'waiting'),
  }
}

export type SummaryTiles = {
  overdue: number
  dueNext7: number
  waitingOnOthers: number
  projectsNeedingAttention: number
  closedThisWeek: number
}

/**
 * The five My Summary tiles, computed from the SAME rows the list uses so they
 * always agree:
 *  - Overdue: my open items overdue;
 *  - Due in next 7 working days: my open items in the next-7 band;
 *  - Waiting on others: my waiting items;
 *  - Projects needing attention: my projects with an attention warning;
 *  - Closed this week: my items marked Done this ISO/display week.
 *
 * "My projects" for the attention tile uses the full access set (owner, lead,
 * member, share, and sub-projects). "Closed this week" counts items done in the
 * current week (week_start-aligned) that are on my projects or were assigned to
 * me.
 */
export function summaryTiles(
  plans: Plan[],
  actions: Action[],
  updates: PlanUpdate[],
  userId: string,
  today: ISODate,
  s: TrackerSettings = DEFAULT_SETTINGS,
  access: PlanAccess = {},
): SummaryTiles {
  const summary = mySummary(actions, plans, userId, today, access)
  const mineProjectIds = myPlanIds(plans, userId, access)
  const attention = planAttention(plans, actions, updates, today, s)
  const weekStart = weekStartOf(today, s.weekStart)
  const weekEnd = addDays(weekStart, 6)
  const live = liveActions(actions, plans)
  const mineClosed = live.filter(
    (a) =>
      ((a.planId !== null && mineProjectIds.has(a.planId)) || a.assigneeId === userId) &&
      a.status === 'done' &&
      a.doneOn !== null &&
      a.doneOn >= weekStart &&
      a.doneOn <= weekEnd,
  )
  // Projects needing attention among mine. Only count top-level attention rows
  // once (planAttention already rolls sub-plan actions into the parent).
  const needingAttention = plans.filter(
    (p) => p.archivedAt === null && mineProjectIds.has(p.id) && attention.get(p.id)?.needsAttention,
  ).length
  return {
    overdue: summary.overdue.length,
    dueNext7: summary.next7.length,
    waitingOnOthers: summary.waiting.length,
    projectsNeedingAttention: needingAttention,
    closedThisWeek: mineClosed.length,
  }
}

export type ActionCounts = {
  overdue: number
  dueThisWeek: number
  waitingOnOthers: number
  callsAndEmails: number
  plansNeedingAttention: number
  closedThisWeek: number
}

/** "My" plans: active plans I own or lead. */
function myPlans(plans: Plan[], userId: string): Plan[] {
  return plans.filter((p) => p.archivedAt === null && (p.ownerId === userId || p.leadId === userId))
}

export function actionCounts(
  plans: Plan[], actions: Action[], updates: PlanUpdate[], userId: string,
  today: ISODate, s: TrackerSettings = DEFAULT_SETTINGS,
): ActionCounts {
  const weekStart = weekStartOf(today, s.weekStart)
  const weekEnd = addDays(weekStart, 6)
  const mine = liveActions(actions, plans).filter((a) => a.assigneeId === userId)
  const attention = planAttention(plans, actions, updates, today, s)
  return {
    overdue: mine.filter((a) => a.status === 'open' && a.dueOn !== null && a.dueOn < today).length,
    dueThisWeek: mine.filter((a) => a.status === 'open' && a.dueOn !== null && a.dueOn >= today && a.dueOn <= weekEnd).length,
    waitingOnOthers: mine.filter((a) => a.status === 'waiting').length,
    callsAndEmails: mine.filter((a) => a.status === 'open' && (a.type === 'call' || a.type === 'email')).length,
    plansNeedingAttention: myPlans(plans, userId).filter((p) => attention.get(p.id)?.needsAttention).length,
    closedThisWeek: mine.filter((a) => a.status === 'done' && a.doneOn !== null && a.doneOn >= weekStart && a.doneOn <= weekEnd).length,
  }
}

// ── Weekly review (FR-6.2, FR-6.3) ─────────────────────────────────────────

/** Actions closed per ISO week by a person. */
export function closedPerWeek(actions: Action[], plans: Plan[], userId: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const a of liveActions(actions, plans)) {
    if (a.assigneeId === userId && a.status === 'done' && a.doneOn !== null) {
      const w = isoWeek(a.doneOn)
      counts.set(w, (counts.get(w) ?? 0) + 1)
    }
  }
  return counts
}

/** The last n ISO weeks ending with this week, last week's count and the average. */
export function closedChart(
  actions: Action[], plans: Plan[], userId: string, today: ISODate, n = 8,
): { weeks: { isoWeek: string; closed: number }[]; lastWeek: number; average: number } {
  const counts = closedPerWeek(actions, plans, userId)
  const weeks: { isoWeek: string; closed: number }[] = []
  for (let i = n - 1; i >= 0; i--) {
    const w = isoWeek(addDays(today, -7 * i))
    weeks.push({ isoWeek: w, closed: counts.get(w) ?? 0 })
  }
  const total = weeks.reduce((sum, w) => sum + w.closed, 0)
  return { weeks, lastWeek: counts.get(isoWeek(addDays(today, -7))) ?? 0, average: total / n }
}

export type HealthChecks = {
  noNextAction: string[]
  waitingTooLong: string[]
  needsStatusCheck: string[]
  noRecentUpdate: string[]
  noDueDate: string[]
}

export function healthChecks(
  plans: Plan[], actions: Action[], updates: PlanUpdate[], userId: string,
  today: ISODate, s: TrackerSettings = DEFAULT_SETTINGS,
): HealthChecks {
  const attention = planAttention(plans, actions, updates, today, s)
  const mineP = myPlans(plans, userId).map((p) => ({ p, at: attention.get(p.id)! }))
  const mineA = liveActions(actions, plans).filter((a) => a.assigneeId === userId)
  const sorted = (ids: string[]) => ids.sort()
  return {
    noNextAction: sorted(mineP.filter((x) => x.at.flags.noOpenAction).map((x) => x.p.id)),
    waitingTooLong: sorted(mineA.filter((a) => isWaitingTooLong(a, today, s)).map((a) => a.id)),
    needsStatusCheck: sorted(mineP.filter((x) => x.at.isActive && x.p.status === 'needs_status_check').map((x) => x.p.id)),
    noRecentUpdate: sorted(mineP.filter((x) => x.at.flags.stale).map((x) => x.p.id)),
    noDueDate: sorted(mineA.filter((a) => a.status === 'open' && a.dueOn === null).map((a) => a.id)),
  }
}
