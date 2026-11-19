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
