/**
 * Unit tests for lib/tracker/import.ts (P4) — the pure import translator.
 * Run: npm run test:tracker
 *
 * All made-up data. These check the translation rules the SQL side relies on:
 * value mapping, name matching, region reuse/add, parent building + loop
 * detection, missing-project problems, bad dates / unknown keys, the new /
 * changed split, and the owner-choice flow. No database is needed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseExport,
  translateExport,
  ImportParseError,
  isIsoDate,
  regionKey,
  titleHash,
  type LegacyExport,
  type ImportContext,
} from './import.ts'

const U_MANAGER = 'aaaaaaaa-0000-0000-0000-000000000001'
const U_MANAGER2 = 'aaaaaaaa-0000-0000-0000-000000000002'
const U_STAFF = 'aaaaaaaa-0000-0000-0000-000000000003'

const baseContext = (over: Partial<ImportContext> = {}): ImportContext => ({
  groupId: 'gggggggg-0000-0000-0000-000000000001',
  people: [
    { id: U_MANAGER, name: 'Ada Lovelace', role: 'manager' },
    { id: U_MANAGER2, name: 'Grace Hopper', role: 'group_owner' },
    { id: U_STAFF, name: 'Alan Turing', role: 'staff' },
  ],
  regions: [{ key: 'perth', label: 'Perth' }],
  lookups: {
    status: ['on_track', 'at_risk', 'blocked', 'finished', 'needs_status_check'],
    milestone_status: ['backlog', 'planned', 'in_progress', 'completed'],
    action_type: ['do', 'call', 'email', 'chase', 'decide', 'meeting'],
    source: ['my_note', 'email', 'screenshot', 'meeting', 'file_folder', 'call'],
    category: ['grants', 'product_software'],
  },
  existing: { plans: [], milestones: [], actions: [], contacts: [], updates: [] },
  ...over,
})

const okExport = (): LegacyExport => ({
  format: 'tracker-export',
  version: 1,
  plans: [
    {
      id: 'P1',
      name: 'Alpha',
      status: 'green',
      category: 'grants',
      region: 'Perth',
      owner: 'Ada Lovelace',
      lead: 'Alan Turing',
      priority: 'high',
      progress_pct: 50,
      updated_on: '2024-01-10',
    },
    {
      id: 'P2',
      name: 'Beta',
      status: 'R',
      region: 'South West',
      owner: 'Grace Hopper',
      parent_id: 'P1',
      archived: true,
    },
  ],
  milestones: [
    { id: 'M1', plan_id: 'P1', title: 'Kickoff', status: 'done', due_on: '2024-02-01' },
  ],
  actions: [
    { id: 'A1', plan_id: 'P1', milestone_id: 'M1', title: 'Call client', type: 'CALL', assignee: 'Alan Turing', status: 'open', due_on: '2024-01-20' },
  ],
  contacts: [{ id: 'C1', name: 'Bob Client', org: 'Acme', owner: 'Ada Lovelace' }],
  contact_links: [{ contact_id: 'C1', plan_id: 'P1' }],
  updates: [{ id: 'U1', plan_id: 'P1', kind: 'update', date: '2024-01-05', source: 'email', text: 'Started' }],
})

// ── parseExport ─────────────────────────────────────────────────────────────

test('parseExport accepts a good file and normalises arrays', () => {
  const f = parseExport(JSON.stringify({ plans: [{ id: 'P1', name: 'X' }] }))
  assert.equal(f.plans?.length, 1)
  assert.deepEqual([f.milestones, f.actions, f.contacts, f.updates].map((a) => a?.length), [0, 0, 0, 0])
})

test('parseExport rejects bad JSON, wrong format, and bad version', () => {
  assert.throws(() => parseExport('{not json'), ImportParseError)
  assert.throws(() => parseExport(JSON.stringify({ format: 'nope' })), ImportParseError)
  assert.throws(() => parseExport(JSON.stringify({ version: 9 })), ImportParseError)
  assert.throws(() => parseExport(JSON.stringify([])), ImportParseError)
})

test('parseExport catches missing ids, missing names, and duplicate ids', () => {
  assert.throws(() => parseExport(JSON.stringify({ plans: [{ name: 'X' }] })), /needs an id/)
  assert.throws(() => parseExport(JSON.stringify({ plans: [{ id: 'P1' }] })), /missing its name/)
  assert.throws(
    () => parseExport(JSON.stringify({ plans: [{ id: 'P1', name: 'A' }, { id: 'P1', name: 'B' }] })),
    /share the id/,
  )
})

test('parseExport catches bad dates', () => {
  assert.throws(
    () => parseExport(JSON.stringify({ plans: [{ id: 'P1', name: 'A', start_on: '2024-13-40' }] })),
    /bad start_on date/,
  )
  assert.throws(
    () => parseExport(JSON.stringify({ updates: [{ id: 'U1', plan_id: 'P1', text: 'x', date: 'yesterday' }] })),
    /bad date date/,
  )
})

test('isIsoDate validates real calendar dates', () => {
  assert.equal(isIsoDate('2024-02-29'), true) // leap year
  assert.equal(isIsoDate('2023-02-29'), false) // not a leap year
  assert.equal(isIsoDate('2024-13-01'), false)
  assert.equal(isIsoDate('2024-1-1'), false)
})

// ── translateExport: happy path ─────────────────────────────────────────────

test('translateExport maps values, matches names, builds parents, adds a region', () => {
  const p = translateExport(okExport(), baseContext())
  assert.deepEqual(p.problems, [])

  const [alpha, beta] = p.payload.plans
  assert.equal(alpha.status, 'on_track') // green → on_track
  assert.equal(alpha.priority, 'high')
  assert.equal(alpha.owner_id, U_MANAGER) // Ada matched
  assert.equal(alpha.lead_id, U_STAFF) // Alan matched
  assert.equal(alpha.region, 'perth') // existing region reused
  assert.equal(alpha.updated_on, '2024-01-10') // preserved

  assert.equal(beta.status, 'blocked') // R → blocked
  assert.equal(beta.archived, true)
  assert.equal(beta.parent_legacy_id, 'P1')
  assert.equal(beta.region, 'south_west') // new region key

  // New region surfaced for the user + in the payload.
  assert.deepEqual(p.newRegions, [{ key: 'south_west', label: 'South West' }])
  assert.deepEqual(p.payload.regions, [{ key: 'south_west', label: 'South West' }])

  // Milestone + action mapping.
  assert.equal(p.payload.milestones[0].status, 'completed') // done → completed
  assert.equal(p.payload.milestones[0].title_hash, titleHash('Kickoff'))
  assert.equal(p.payload.actions[0].type, 'call') // CALL → call
  assert.equal(p.payload.actions[0].assignee_id, U_STAFF)
  assert.equal(p.payload.actions[0].milestone_legacy_id, 'M1')

  // Contacts + link + update source.
  assert.equal(p.payload.contacts[0].owner_id, U_MANAGER)
  assert.deepEqual(p.payload.contact_links, [{ contact_legacy_id: 'C1', plan_legacy_id: 'P1' }])
  assert.equal(p.payload.updates[0].source, 'email')
})

test('project rows report state and owner-choice need', () => {
  const p = translateExport(okExport(), baseContext())
  const rows = Object.fromEntries(p.projects.map((r) => [r.legacy_id, r]))
  assert.equal(rows.P1.state, 'new')
  assert.equal(rows.P1.ownerNeedsChoice, false)
  assert.equal(rows.P1.milestones, 1)
  assert.equal(rows.P1.actions, 1)
})

// ── new vs changed ──────────────────────────────────────────────────────────

test('existing legacy ids read as changed; re-import with choices stays clean', () => {
  const ctx = baseContext({
    existing: { plans: ['P1', 'P2'], milestones: ['M1'], actions: ['A1'], contacts: ['C1'], updates: ['U1'] },
  })
  const p = translateExport(okExport(), ctx)
  assert.deepEqual(p.counts.plans, { new: 0, changed: 2, unchanged: 0 })
  assert.deepEqual(p.counts.milestones, { new: 0, changed: 1, unchanged: 0 })
  assert.equal(p.projects.every((r) => r.state === 'changed'), true)
  assert.deepEqual(p.problems, [])
})

// ── owner resolution + choices ──────────────────────────────────────────────

test('an unmatched owner blocks until a choice is supplied', () => {
  const f = okExport()
  f.plans![0].owner = 'Nobody Here'
  const p1 = translateExport(f, baseContext())
  assert.equal(p1.projects.find((r) => r.legacy_id === 'P1')!.ownerNeedsChoice, true)
  assert.ok(p1.problems.some((m) => /Choose an owner for project "Alpha"/.test(m)))

  // Supplying a choice clears it.
  const p2 = translateExport(f, baseContext(), [{ legacyPlanId: 'P1', ownerId: U_MANAGER2 }])
  assert.equal(p2.payload.plans[0].owner_id, U_MANAGER2)
  assert.ok(!p2.problems.some((m) => /Choose an owner/.test(m)))
})

test('a non-editor owner choice is refused', () => {
  const p = translateExport(okExport(), baseContext(), [{ legacyPlanId: 'P1', ownerId: U_STAFF }])
  assert.ok(p.problems.some((m) => /must be a Manager or Group Owner/.test(m)))
})

// ── integrity problems ──────────────────────────────────────────────────────

test('a milestone pointing at a missing project is a problem', () => {
  const f = okExport()
  f.milestones = [{ id: 'M9', plan_id: 'GONE', title: 'Orphan' }]
  const p = translateExport(f, baseContext())
  assert.ok(p.problems.some((m) => /Milestone "Orphan" points at a project/.test(m)))
})

test('a parent not in the file is a problem', () => {
  const f = okExport()
  f.plans![1].parent_id = 'MISSING'
  const p = translateExport(f, baseContext())
  assert.ok(p.problems.some((m) => /parent \(MISSING\) that isn't in this file/.test(m)))
})

test('a parent loop is detected', () => {
  const f: LegacyExport = {
    plans: [
      { id: 'X', name: 'X', owner: 'Ada Lovelace', parent_id: 'Y' },
      { id: 'Y', name: 'Y', owner: 'Ada Lovelace', parent_id: 'X' },
    ],
  }
  const p = translateExport(f, baseContext())
  assert.ok(p.problems.some((m) => /parent loop/.test(m)))
})

test('unknown status/type values are left blank with a note, not an error', () => {
  const f = okExport()
  f.plans![0].status = 'teal'
  f.actions![0].type = 'telepathy'
  const p = translateExport(f, baseContext())
  assert.equal(p.payload.plans[0].status, null)
  assert.equal(p.payload.actions[0].type, null)
  assert.ok(p.notes.some((n) => /Status value "teal"/.test(n)))
  assert.ok(p.notes.some((n) => /Action type value "telepathy"/.test(n)))
  // These are notes, not blocking problems.
  assert.ok(!p.problems.some((m) => /teal|telepathy/.test(m)))
})

test('an ambiguous name does not resolve', () => {
  const ctx = baseContext({
    people: [
      { id: U_MANAGER, name: 'Sam Twin', role: 'manager' },
      { id: U_MANAGER2, name: 'Sam Twin', role: 'manager' },
      { id: U_STAFF, name: 'Alan Turing', role: 'staff' },
    ],
  })
  const f = okExport()
  f.plans![0].owner = 'Sam Twin'
  const p = translateExport(f, ctx)
  assert.equal(p.projects.find((r) => r.legacy_id === 'P1')!.ownerNeedsChoice, true)
})

// ── helpers ─────────────────────────────────────────────────────────────────

test('regionKey + titleHash are stable and tidy', () => {
  assert.equal(regionKey('  South  West! '), 'south_west')
  assert.equal(regionKey('Perth'), 'perth')
  assert.equal(titleHash('Kickoff'), titleHash('  kickoff '))
  assert.notEqual(titleHash('Kickoff'), titleHash('Launch'))
})
