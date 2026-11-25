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
  buildContactPatch,
  createProjectRefusal,
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
  // A provided progress also flips the milestone to 'manual' so the hand value
  // shows even if it was in 'from_actions' mode (see the dedicated test below).
  assert.deepEqual(full, {
    status: 'in_progress',
    due_on: '2026-12-05',
    progress_pct: 100,
    progress_mode: 'manual',
  })
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

// ── Part 5 fix: a raw "progress 50%" project proposal, no milestone named ─────

test('raw "progress 50%" on a project yields update_plan with ONLY progress_pct', () => {
  // The exact shape the model sends for "update the status, progress to 50%" on
  // a project with no milestones: progress belongs to the PROJECT, so it is an
  // update_plan with progress_pct: 50 and nothing else (no milestone change).
  const input = {
    changes: [
      {
        kind: 'update_plan',
        label: 'Field trials – NSW: progress → 50%',
        planId: 'p1',
        progressPct: 50,
      },
    ],
  }
  const change = onlyChange(input)
  assert.deepEqual(change, { kind: 'update_plan', planId: 'p1', progressPct: 50 })
  assert.equal(change.kind, 'update_plan')
  if (change.kind !== 'update_plan') throw new Error('wrong kind')
  const patch = buildPlanPatch(change)
  assert.deepEqual(patch, { progress_pct: 50 })
  assert.ok(!('status' in patch))
  assert.ok(!('phase' in patch))
})

// ── Part 5 fix: milestone progress switches to "set by hand" so it shows ──────

test('setting a milestone progress also sets progress_mode to manual', () => {
  // A milestone in 'from_actions' mode ignores progress_pct; setting a progress
  // value must flip it to 'manual' so the new percentage shows on the page.
  const patch = buildMilestonePatch({
    kind: 'update_milestone',
    milestoneId: 'm1',
    progressPct: 50,
  })
  assert.deepEqual(patch, { progress_pct: 50, progress_mode: 'manual' })

  // No progress value → no mode change (status-only edits are untouched).
  const statusOnly = buildMilestonePatch({
    kind: 'update_milestone',
    milestoneId: 'm1',
    status: 'in_progress',
  })
  assert.deepEqual(statusOnly, { status: 'in_progress' })
  assert.ok(!('progress_mode' in statusOnly))
})

// ── New change kind: update_contact (only the fields given) ───────────────────

test('raw model input → update_contact changes ONLY the field given', () => {
  // "Pat's phone is now 0400 000 123" — only the phone is mentioned, so only
  // the phone may be written; email/org/role/notes are left untouched.
  const input = {
    changes: [
      {
        kind: 'update_contact',
        label: 'Pat Doe: phone → 0400 000 123',
        contactId: 'ct1',
        phone: '0400 000 123',
      },
    ],
  }
  const change = onlyChange(input)
  assert.deepEqual(change, { kind: 'update_contact', contactId: 'ct1', phone: '0400 000 123' })
  assert.ok(!('email' in change))
  assert.ok(!('org' in change))

  assert.equal(change.kind, 'update_contact')
  if (change.kind !== 'update_contact') throw new Error('wrong kind')
  const patch = buildContactPatch(change)
  assert.deepEqual(patch, { phone: '0400 000 123' })
  assert.ok(!('email' in patch), 'email must be left unchanged')
  assert.ok(!('org' in patch), 'organisation must be left unchanged')
  assert.ok(!('role' in patch))
  assert.ok(!('notes' in patch))
})

test('update_contact needs a contactId', () => {
  assert.equal(toChange('update_contact', { phone: '0400 000 123' }), null)
})

// ── New change kind: create_project (only the fields given) ───────────────────

test('raw model input → create_project keeps only the fields given', () => {
  // "New project Smart irrigation – stage 2, Grants, under the grant, lead Sam."
  const input = {
    changes: [
      {
        kind: 'create_project',
        label: 'New project "Smart irrigation – stage 2" (Grants), under "Smart irrigation grant", lead Sam Lee',
        name: 'Smart irrigation – stage 2',
        category: 'grants',
        parentId: 'p-parent',
        leadId: 'u-sam',
      },
    ],
  }
  const change = onlyChange(input)
  assert.deepEqual(change, {
    kind: 'create_project',
    name: 'Smart irrigation – stage 2',
    category: 'grants',
    parentId: 'p-parent',
    leadId: 'u-sam',
  })
  // No status/client/phase/region/members/summary were given → none present.
  assert.ok(!('status' in change))
  assert.ok(!('client' in change))
  assert.ok(!('region' in change))
  assert.ok(!('memberIds' in change))
})

test('create_project needs a name AND a category', () => {
  assert.equal(toChange('create_project', { name: 'Stage 2' }), null) // no category
  assert.equal(toChange('create_project', { category: 'grants' }), null) // no name
})

test('create_project is refused for a non-Manager at apply time', () => {
  const change = toChange('create_project', {
    name: 'Stage 2',
    category: 'grants',
  }) as Extract<ProposedChange, { kind: 'create_project' }>
  // A non-editor (Staff) is refused with a clear line…
  assert.equal(
    createProjectRefusal(change, false),
    'Only Managers or Group Owners can create a project',
  )
  // …and an editor (Manager / Group Owner) may proceed.
  assert.equal(createProjectRefusal(change, true), null)
})

// ── New change kind: add_comment ──────────────────────────────────────────────

test('raw model input → add_comment carries the project and text', () => {
  const input = {
    changes: [
      {
        kind: 'add_comment',
        label: 'Field trials 2026 – NSW: comment "Waiting on council approval before install."',
        planId: 'p1',
        text: 'Waiting on council approval before install.',
      },
    ],
  }
  const change = onlyChange(input)
  assert.deepEqual(change, {
    kind: 'add_comment',
    planId: 'p1',
    text: 'Waiting on council approval before install.',
  })
})

test('add_comment needs both a project and text', () => {
  assert.equal(toChange('add_comment', { planId: 'p1' }), null) // no text
  assert.equal(toChange('add_comment', { text: 'hi' }), null) // no planId
})

// ── An answer reply contains no changes ───────────────────────────────────────

test('an answer turn (no propose_changes) proposes nothing', () => {
  // The route turns an `answer` tool call into a plain-text turn and never
  // builds a proposal. A propose_changes call with an empty changes list — the
  // nearest raw-input check available here — likewise yields no changes.
  const turn = buildProposalTurn({ changes: [] }, 'Nothing to change')
  assert.equal(turn.type, 'proposal')
  if (turn.type !== 'proposal') throw new Error('not a proposal')
  assert.equal(turn.changes.length, 0)
})
