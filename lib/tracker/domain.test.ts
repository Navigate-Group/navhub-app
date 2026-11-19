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
