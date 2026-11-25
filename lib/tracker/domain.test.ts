/**
 * Unit tests for lib/tracker/domain.ts (P3).
 * Run: npm run test:tracker
 *
 * The fixture and expected numbers here are the SAME as in
 * supabase/tests/083_tracker_views_test.sql, which checks the SQL views. If
 * both pass, the code and the views agree (SRS AC-4). Today is pinned to
 * Thursday 19 Nov 2026 (ISO week 2026-W47, Mon 16 – Sun 22 Nov).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  type Action, type Milestone, type Plan, type PlanUpdate,
  DEFAULT_SETTINGS, actionCounts, addDays, closedChart, closedPerWeek, daysBetween,
  healthChecks, isoWeek, isWaitingTooLong, milestoneProgress, myWeek, planAttention,
  todayIn, waitingDueDate, weekStartOf,
  isWeekend, workingDayOne, nthWorkingDay, dateBandBounds, dateBandOf,
  myPlanIds, myEditablePlanIds, mySummary, summaryTiles,
} from './domain.ts'

const TODAY = '2026-11-19'
const U1 = '20000000-0000-0000-0000-000000000001' // manager, owns every plan
const U2 = '20000000-0000-0000-0000-000000000002' // staff, leads P2
const P = (n: number) => `30000000-0000-0000-0000-00000000000${n}`
const M = (n: number) => `40000000-0000-0000-0000-00000000000${n}`
const A = (n: number) => `50000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`

const plan = (n: number, o: Partial<Plan>): Plan => ({
  id: P(n), parentId: null, status: 'on_track', ownerId: U1, leadId: null,
  updatedOn: TODAY, archivedAt: null, ...o,
})

const plans: Plan[] = [
  plan(1, { updatedOn: '2026-11-18' }),                                   // P1 parent
  plan(2, { parentId: P(1), updatedOn: '2026-11-10' }),                   // P1a sub-plan
  plan(3, { status: 'at_risk', leadId: U2, updatedOn: '2026-10-01' }),    // P2
  plan(4, { status: 'needs_status_check', updatedOn: '2026-11-17' }),     // P3
  plan(5, { status: 'finished', updatedOn: '2026-01-01' }),               // P4
  plan(6, { archivedAt: '2026-11-01T00:00:00Z' }),                        // P5 archived
]

const updates: PlanUpdate[] = [{ planId: P(3), date: '2026-10-20' }]

const act = (n: number, o: Partial<Action>): Action => ({
  id: A(n), planId: P(1), milestoneId: null, title: `A${n}`, type: 'do', assigneeId: U1,
  dueOn: null, status: 'open', waitingSince: null, doneOn: null, createdOn: '2026-11-01',
  archivedAt: null, ...o,
})

const actions: Action[] = [
  act(1, { planId: P(2), assigneeId: U2, dueOn: '2026-11-17', type: 'call' }),        // overdue
  act(2, { dueOn: '2026-11-19' }),                                                     // today
  act(3, { dueOn: '2026-11-21', type: 'email' }),                                      // rest of week
  act(4, { dueOn: '2026-11-25' }),                                                     // next week
  act(5, { dueOn: '2026-12-10' }),                                                     // later
  act(6, { type: 'decide' }),                                                          // no date
  act(7, { planId: P(3), assigneeId: U2, status: 'waiting', waitingSince: '2026-11-10', dueOn: '2026-11-15' }),
  act(8, { planId: P(3), assigneeId: U2, status: 'waiting', waitingSince: '2026-11-17', dueOn: '2026-11-22' }),
  act(9, { status: 'done', doneOn: '2026-11-17', milestoneId: M(1) }),
  act(10, { status: 'done', doneOn: '2026-11-10', milestoneId: M(1) }),
  act(11, { dueOn: '2026-11-30', milestoneId: M(1) }),                                 // later
  act(12, { planId: null, assigneeId: U2, type: 'call' }),                             // plan-less, no date
  act(13, { planId: P(6), dueOn: '2026-11-01' }),                                      // on archived plan
  act(14, { dueOn: '2026-11-18', archivedAt: '2026-11-18T00:00:00Z' }),                // archived
]

const ms = (n: number, o: Partial<Milestone>): Milestone => ({
  id: M(n), planId: P(1), status: 'planned', dueOn: null, baselineDueOn: null,
  progressMode: 'from_actions', progressPct: 0, archivedAt: null, ...o,
})

const milestones: Milestone[] = [
  ms(1, { status: 'in_progress', dueOn: '2026-11-25', baselineDueOn: '2026-11-20' }),
  ms(2, { progressMode: 'manual', progressPct: 40, dueOn: '2026-11-12' }),
  ms(3, { planId: P(3) }),
  ms(4, { planId: P(4), status: 'completed', dueOn: '2026-11-01' }),
]

const ids = (xs: Action[]) => xs.map((a) => a.id)

test('date maths', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01')
  assert.equal(daysBetween('2026-10-20', TODAY), 30)
  assert.equal(weekStartOf(TODAY, 'monday'), '2026-11-16')
  assert.equal(weekStartOf(TODAY, 'sunday'), '2026-11-15')
  assert.equal(isoWeek(TODAY), '2026-W47')
  assert.equal(isoWeek('2026-11-10'), '2026-W46')
  assert.equal(isoWeek('2027-01-01'), '2026-W53')
  assert.equal(todayIn('Australia/Perth', new Date('2026-11-18T17:00:00Z')), '2026-11-19')
})

test('waiting chaser', () => {
  assert.equal(waitingDueDate(TODAY), '2026-11-24')
  assert.equal(isWaitingTooLong(actions[6], TODAY), true)   // waiting 9 days
  assert.equal(isWaitingTooLong(actions[7], TODAY), false)  // waiting 2 days
})

test('plan attention', () => {
  const at = planAttention(plans, actions, updates, TODAY)
  assert.equal(at.size, 5) // archived P5 left out
  const p1 = at.get(P(1))!
  assert.deepEqual([p1.openActions, p1.subPlans, p1.nextAction?.id, p1.lastUpdated], [7, 1, A(1), '2026-11-18'])
  assert.deepEqual(p1.flags, { status: false, noOpenAction: false, overdueAction: true, stale: false })
  const p1a = at.get(P(2))!
  assert.deepEqual([p1a.openActions, p1a.nextAction?.id, p1a.needsAttention], [1, A(1), true])
  const p2 = at.get(P(3))!
  assert.deepEqual([p2.openActions, p2.nextAction, p2.lastUpdated], [2, null, '2026-10-20'])
  assert.deepEqual(p2.flags, { status: true, noOpenAction: false, overdueAction: false, stale: true })
  const p3 = at.get(P(4))!
  assert.deepEqual(p3.flags, { status: true, noOpenAction: true, overdueAction: false, stale: false })
  const p4 = at.get(P(5))!
  assert.deepEqual([p4.isActive, p4.needsAttention], [false, false])
})

test('milestone progress', () => {
  const got = milestones.map((m) => milestoneProgress(m, actions, TODAY))
  assert.deepEqual(got.map((g) => [g.doneActions, g.totalActions, g.progressPct, g.daysSlipped, g.overdue]), [
    [2, 3, 67, 5, false],
    [0, 0, 40, null, true],
    [0, 0, 0, null, false],
    [0, 0, 0, null, false],
  ])
})

test('my week groups', () => {
  const w1 = myWeek(actions, plans, U1, TODAY)
  assert.deepEqual(
    [ids(w1.overdue), ids(w1.today), ids(w1.restOfWeek), ids(w1.nextWeek), ids(w1.later), ids(w1.noDate)],
    [[], [A(2)], [A(3)], [A(4)], [A(11), A(5)], [A(6)]])
  const w2 = myWeek(actions, plans, U2, TODAY)
  assert.deepEqual([ids(w2.overdue), ids(w2.noDate), ids(w2.waiting), ids(w2.calls)],
    [[A(1)], [A(12)], [A(7), A(8)], [A(1), A(12)]])
})

test('my week tiles', () => {
  assert.deepEqual(actionCounts(plans, actions, updates, U1, TODAY), {
    overdue: 0, dueThisWeek: 2, waitingOnOthers: 0, callsAndEmails: 1, plansNeedingAttention: 4, closedThisWeek: 1,
  })
  assert.deepEqual(actionCounts(plans, actions, updates, U2, TODAY), {
    overdue: 1, dueThisWeek: 0, waitingOnOthers: 2, callsAndEmails: 2, plansNeedingAttention: 1, closedThisWeek: 0,
  })
})

test('closed per week', () => {
  assert.deepEqual([...closedPerWeek(actions, plans, U1)].sort(), [['2026-W46', 1], ['2026-W47', 1]])
  const chart = closedChart(actions, plans, U1, TODAY)
  assert.deepEqual(chart.weeks.map((w) => w.closed), [0, 0, 0, 0, 0, 0, 1, 1])
  assert.equal(chart.weeks[7].isoWeek, '2026-W47')
  assert.deepEqual([chart.lastWeek, chart.average], [1, 0.25])
})

test('health checks', () => {
  assert.deepEqual(healthChecks(plans, actions, updates, U1, TODAY), {
    noNextAction: [P(4)], waitingTooLong: [], needsStatusCheck: [P(4)], noRecentUpdate: [P(3)], noDueDate: [A(6)],
  })
  assert.deepEqual(healthChecks(plans, actions, updates, U2, TODAY), {
    noNextAction: [], waitingTooLong: [A(7)], needsStatusCheck: [], noRecentUpdate: [P(3)], noDueDate: [A(12)],
  })
})

test('settings are honoured', () => {
  const s = { ...DEFAULT_SETTINGS, staleDays: 40, chaserDays: 10 }
  assert.equal(planAttention(plans, actions, updates, TODAY, s).get(P(3))!.flags.stale, false)
  assert.equal(isWaitingTooLong(actions[6], TODAY, s), false)
})

// ── My Summary: working-day date bands ───────────────────────────────────────

test('weekend detection', () => {
  assert.equal(isWeekend('2026-11-27'), false) // Friday
  assert.equal(isWeekend('2026-11-28'), true)  // Saturday
  assert.equal(isWeekend('2026-11-29'), true)  // Sunday
  assert.equal(isWeekend('2026-11-30'), false) // Monday
})

test('working day 1 is today on a weekday, next Monday on a weekend', () => {
  assert.equal(workingDayOne('2026-11-27'), '2026-11-27') // Friday → itself
  assert.equal(workingDayOne('2026-11-28'), '2026-11-30') // Saturday → Monday
  assert.equal(workingDayOne('2026-11-29'), '2026-11-30') // Sunday → Monday
  assert.equal(workingDayOne('2026-11-19'), '2026-11-19') // Thursday → itself
})

test('nth working day spans weekends', () => {
  // From Thursday 19 Nov 2026: day 1 Thu, day 2 Fri, day 3 Mon 23, …
  assert.equal(nthWorkingDay('2026-11-19', 1), '2026-11-19')
  assert.equal(nthWorkingDay('2026-11-19', 2), '2026-11-20')
  assert.equal(nthWorkingDay('2026-11-19', 3), '2026-11-23') // skips Sat/Sun
  assert.equal(nthWorkingDay('2026-11-19', 7), '2026-11-27')
})

test('date band bounds match the brief examples', () => {
  // Friday 27 Nov 2026: next 7 working days = 27 Nov – 7 Dec.
  const fri = dateBandBounds('2026-11-27')
  assert.deepEqual([fri.dayOne, fri.end7], ['2026-11-27', '2026-12-07'])
  assert.deepEqual([fri.end14, fri.end30], ['2026-12-16', '2027-01-07'])
  // Saturday 28 Nov 2026: starts Mon 30 Nov, next 7 working days = 30 Nov – 8 Dec.
  const sat = dateBandBounds('2026-11-28')
  assert.deepEqual([sat.dayOne, sat.end7], ['2026-11-30', '2026-12-08'])
  assert.deepEqual([sat.end14, sat.end30], ['2026-12-17', '2027-01-08'])
})

test('date band classification and edges', () => {
  const today = '2026-11-27' // Friday; end7 = 7 Dec, end14 = 16 Dec, end30 = 7 Jan
  assert.equal(dateBandOf(null, today), 'noDate')
  assert.equal(dateBandOf('2026-11-26', today), 'overdue')  // day before today
  assert.equal(dateBandOf('2026-11-27', today), 'next7')    // today itself
  assert.equal(dateBandOf('2026-12-07', today), 'next7')    // last day of next7
  assert.equal(dateBandOf('2026-12-08', today), 'days8to14')// first of 8–14
  assert.equal(dateBandOf('2026-12-16', today), 'days8to14')// last of 8–14
  assert.equal(dateBandOf('2026-12-17', today), 'days15to30')// first of 15–30
  assert.equal(dateBandOf('2027-01-07', today), 'days15to30')// last of 15–30
  assert.equal(dateBandOf('2027-01-08', today), null)        // past day 30 — hidden
})

// ── My Summary: access rules and grouping ────────────────────────────────────
//
// U1 owns every plan; U2 leads P2 (P3 in the fixture's P(n) ids). Set up a
// member/share fixture for a third person to exercise membership and sharing.
const U3 = '20000000-0000-0000-0000-000000000003'

test('my projects: owner, lead, member, share and sub-projects', () => {
  // U1 owns all live plans (P1, P1a, P2, P3, P4). P4 is finished but not
  // archived, so it still counts as "mine" for the summary (open items shown).
  const mineU1 = myPlanIds(plans, U1)
  assert.deepEqual([...mineU1].sort(), [P(1), P(2), P(3), P(4), P(5)].sort())

  // U2 leads P2 (= P(3)); no membership/shares → just that project.
  assert.deepEqual([...myPlanIds(plans, U2)].sort(), [P(3)].sort())

  // U3 is a member of the parent P1 (= P(1)); the sub-project P1a (= P(2))
  // must be included by inheritance.
  const mineU3 = myPlanIds(plans, U3, { memberPlanIds: [P(1)] })
  assert.deepEqual([...mineU3].sort(), [P(1), P(2)].sort())

  // A Comment/Edit share on the sub-project alone does NOT open its parent.
  const mineU3b = myPlanIds(plans, U3, { sharedPlanIds: [P(2)] })
  assert.deepEqual([...mineU3b], [P(2)])

  // Archived plans never count (P5 = P(6) is archived).
  assert.equal(myPlanIds(plans, U3, { memberPlanIds: [P(6)] }).has(P(6)), false)
})

test('editable projects: owner/lead/edit-share only, with sub-projects', () => {
  // Member access does not grant edit; only owner/lead/edit-share do.
  assert.equal(myEditablePlanIds(plans, U3, { memberPlanIds: [P(1)] }).size, 0)
  const editU3 = myEditablePlanIds(plans, U3, { editSharePlanIds: [P(1)] })
  assert.deepEqual([...editU3].sort(), [P(1), P(2)].sort()) // parent + sub
})

test('my summary groups open items by band, including unassigned on my projects', () => {
  // U1 owns all projects, so every live open action on them is "mine",
  // whoever it's assigned to (A(1) is assigned to U2 but on P1a = P(2)).
  const s = mySummary(actions, plans, U1, TODAY)
  const idList = (xs: Action[]) => xs.map((a) => a.id)
  // Overdue: A(1) due 17 Nov (on P1a, assigned to U2 — still mine as owner).
  assert.deepEqual(idList(s.overdue), [A(1)])
  // No date: A(6) (U1's own, no date).
  assert.ok(idList(s.noDate).includes(A(6)))
  // Waiting items on my projects (A(7), A(8) on P2 = P(3)).
  assert.deepEqual(idList(s.waiting).sort(), [A(7), A(8)].sort())

  // A staff member who owns/leads nothing but is assigned A(1) still sees it,
  // even though the project isn't otherwise theirs.
  const sU2 = mySummary(actions, plans, U2, TODAY)
  assert.ok(sU2.overdue.some((a) => a.id === A(1)))
})

test('items past working day 30 are not shown', () => {
  const far: Action = act(99, { planId: P(1), dueOn: '2027-06-01' })
  const s = mySummary([...actions, far], plans, U1, TODAY)
  const all = [...s.overdue, ...s.next7, ...s.days8to14, ...s.days15to30, ...s.noDate]
  assert.equal(all.some((a) => a.id === A(99)), false)
})

test('summary tiles match the list counts', () => {
  const s = mySummary(actions, plans, U1, TODAY)
  const t = summaryTiles(plans, actions, updates, U1, TODAY)
  assert.equal(t.overdue, s.overdue.length)
  assert.equal(t.dueNext7, s.next7.length)
  assert.equal(t.waitingOnOthers, s.waiting.length)
  assert.ok(t.projectsNeedingAttention >= 0)
  assert.ok(t.closedThisWeek >= 0)
})
