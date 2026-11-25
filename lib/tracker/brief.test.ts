/**
 * Unit tests for lib/tracker/brief.ts — the Briefing agent's patch builders.
 * Run: npm run test:tracker
 *
 * These guard the data-loss fix: a proposed change must only write the fields
 * the model actually provided. A field the model did NOT mention is OMITTED
 * from the database patch, so it is left exactly as it was — a status-only
 * project change must not clear its phase/summary, and a done-only action
 * change must not clear its assignee (or any other field).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildActionPatch,
  buildMilestonePatch,
  buildPlanPatch,
  buildProposalTurn,
  toChange,
  clampPct,
  isIsoDate,
  type ProposedChange,
} from './brief.ts'

// ── The two cases the brief calls out explicitly ─────────────────────────────

test('status-only project change touches ONLY the status', () => {
  // The model gave a status and nothing else: phase, summary, priority, dates
  // and progress were never mentioned, so none may appear in the patch.
  const patch = buildPlanPatch({
    kind: 'update_plan',
    planId: 'p1',
    status: 'at_risk',
  })
  assert.deepEqual(patch, { status: 'at_risk' })
  // Guard the specific fields the old bug wiped.
  assert.ok(!('phase' in patch), 'phase must be left unchanged')
  assert.ok(!('summary' in patch), 'summary must be left unchanged')
})

test('done-only action change touches ONLY the status', () => {
  // Marking an action done with nothing else: the assignee, due date and title
  // were never mentioned, so none may appear in the patch (so an assignee
  // without edit access is never cleared).
  const patch = buildActionPatch({
    kind: 'update_action',
    actionId: 'a1',
    status: 'done',
  })
  assert.deepEqual(patch, { status: 'done' })
  assert.ok(!('assignee_id' in patch), 'assignee must be left unchanged')
  assert.ok(!('due_on' in patch), 'due date must be left unchanged')
  assert.ok(!('title' in patch), 'title must be left unchanged')
})

// ── Fields ARE written when the model provides them ──────────────────────────

test('provided fields are written', () => {
  const action = buildActionPatch({
    kind: 'update_action',
    actionId: 'a1',
    status: 'waiting',
    dueOn: '2026-12-05',
    assigneeId: 'u2',
    title: '  Chase Pat  ',
  })
  assert.deepEqual(action, {
    status: 'waiting',
    due_on: '2026-12-05',
    assignee_id: 'u2',
    title: 'Chase Pat',
  })

  const plan = buildPlanPatch({
    kind: 'update_plan',
    planId: 'p1',
    status: 'on_track',
    phase: 'Build',
    summary: 'All sites installed',
    priority: 'high',
    progressPct: 42,
    startOn: '2026-01-01',
    endOn: '2026-12-31',
  })
  assert.deepEqual(plan, {
    status: 'on_track',
    phase: 'Build',
    summary: 'All sites installed',
    priority: 'high',
    progress_pct: 42,
    start_on: '2026-01-01',
    end_on: '2026-12-31',
  })
})

test('an explicit null assignee clears it, but an omitted one does not', () => {
  // An explicit clear (assigneeId === null) IS applied...
  const cleared = buildActionPatch({
    kind: 'update_action',
    actionId: 'a1',
    assigneeId: null,
  })
  assert.deepEqual(cleared, { assignee_id: null })

  // ...whereas omitting it leaves the field untouched.
  const kept = buildActionPatch({ kind: 'update_action', actionId: 'a1', status: 'open' })
  assert.ok(!('assignee_id' in kept))
})

test('milestone change only writes provided fields', () => {
  const statusOnly = buildMilestonePatch({
    kind: 'update_milestone',
    milestoneId: 'm1',
    status: 'done',
  })
  assert.deepEqual(statusOnly, { status: 'done' })
  assert.ok(!('due_on' in statusOnly))
  assert.ok(!('progress_pct' in statusOnly))

  const full = buildMilestonePatch({
    kind: 'update_milestone',
    milestoneId: 'm1',
    status: 'in_progress',
    dueOn: '2026-12-05',
    progressPct: 150, // clamped to 100
  })
  assert.deepEqual(full, { status: 'in_progress', due_on: '2026-12-05', progress_pct: 100 })
})

// ── Validation helpers ───────────────────────────────────────────────────────

test('invalid dates throw so the route can report them', () => {
  assert.throws(
    () => buildActionPatch({ kind: 'update_action', actionId: 'a1', dueOn: 'next week' }),
    /Invalid due date/,
  )
  assert.throws(
    () => buildPlanPatch({ kind: 'update_plan', planId: 'p1', startOn: 'soon' }),
    /Invalid start date/,
  )
  assert.throws(
    () => buildPlanPatch({ kind: 'update_plan', planId: 'p1', endOn: 'later' }),
    /Invalid end date/,
  )
})

test('isIsoDate and clampPct behave', () => {
  assert.equal(isIsoDate('2026-12-05'), true)
  assert.equal(isIsoDate('5 Dec'), false)
  assert.equal(isIsoDate(null), false)
  assert.equal(clampPct(150), 100)
  assert.equal(clampPct(-5), 0)
  assert.equal(clampPct(42.6), 43)
  assert.equal(clampPct(null), undefined)
  assert.equal(clampPct(undefined), undefined)
})

// ── The full pipeline: raw model input → change → final patch ────────────────
//
// These start from the exact shape the model hands the `propose_changes` tool
// (a loose Record<string, unknown>) and run it through buildProposalTurn /
// toChange and then the patch builder, mirroring what the route and apply route
// do. This is the step where the data-loss bug began, so the guarantee is
// checked end to end, not just on the builders.

/** Pull the single change of the given kind out of a proposal turn. */
function onlyChange(input: Record<string, unknown>): ProposedChange {
  const turn = buildProposalTurn(input, null)
  assert.equal(turn.type, 'proposal')
  if (turn.type !== 'proposal') throw new Error('not a proposal')
  assert.equal(turn.changes.length, 1)
  return turn.changes[0].change
}

test('raw model input → patch: a status-only project change leaves every other field out', () => {
  // Exactly what the model sends for "mark this project at risk": a kind, a
  // label, the project id and a status — nothing else.
  const input = {
    intro: 'One change',
    changes: [
      {
        kind: 'update_plan',
        label: 'Field trials – NSW: set status to At risk',
        planId: 'p1',
        status: 'at_risk',
      },
    ],
  }

  const change = onlyChange(input)
  assert.deepEqual(change, { kind: 'update_plan', planId: 'p1', status: 'at_risk' })
  // phase/summary/etc never entered the typed change…
  assert.ok(!('phase' in change))
  assert.ok(!('summary' in change))

  // …and so never reach the database patch.
  assert.equal(change.kind, 'update_plan')
  if (change.kind !== 'update_plan') throw new Error('wrong kind')
  const patch = buildPlanPatch(change)
  assert.deepEqual(patch, { status: 'at_risk' })
  assert.ok(!('phase' in patch), 'phase must be left unchanged')
  assert.ok(!('summary' in patch), 'summary must be left unchanged')
  assert.ok(!('priority' in patch))
  assert.ok(!('progress_pct' in patch))
})

test('raw model input → patch: a done-only action change leaves every other field out', () => {
  const input = {
    changes: [
      {
        kind: 'update_action',
        label: 'Chase supplier: mark done',
        actionId: 'a1',
        status: 'done',
      },
    ],
  }

  const change = onlyChange(input)
  assert.deepEqual(change, { kind: 'update_action', actionId: 'a1', status: 'done' })
  assert.ok(!('assigneeId' in change))
  assert.ok(!('dueOn' in change))
  assert.ok(!('title' in change))

  assert.equal(change.kind, 'update_action')
  if (change.kind !== 'update_action') throw new Error('wrong kind')
  const patch = buildActionPatch(change)
  assert.deepEqual(patch, { status: 'done' })
  assert.ok(!('assignee_id' in patch), 'assignee must be left unchanged')
  assert.ok(!('due_on' in patch), 'due date must be left unchanged')
  assert.ok(!('title' in patch), 'title must be left unchanged')
})

test('toChange drops empty strings so blanks never become writes', () => {
  // The model sometimes emits '' for fields it means to leave alone; these must
  // be treated as absent, not as an explicit value.
  const change = toChange('update_plan', { planId: 'p1', status: 'on_track', phase: '', summary: '   ' })
  assert.deepEqual(change, { kind: 'update_plan', planId: 'p1', status: 'on_track' })
  assert.equal(change?.kind, 'update_plan')
  if (change?.kind !== 'update_plan') throw new Error('wrong kind')
  assert.deepEqual(buildPlanPatch(change), { status: 'on_track' })
})

test('toChange returns null when a change lacks the ids it needs', () => {
  assert.equal(toChange('update_plan', { status: 'at_risk' }), null) // no planId
  assert.equal(toChange('update_action', { status: 'done' }), null) // no actionId
  assert.equal(toChange('add_action', { planId: 'p1' }), null) // no title
  assert.equal(toChange('unknown_kind', { planId: 'p1' }), null)
})
