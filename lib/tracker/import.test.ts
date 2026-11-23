/**
 * Unit tests for lib/tracker/import.ts (P4b).
 * Run: npm run test:tracker
 *
 * Made-up data covering every rule in the brief: file-shape validation, value
 * maps, owner choice, assignee/contact matching, regions, milestones,
 * handover, reviews, dates, re-import counts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  type ImportContext,
  parseExport, translateExport,
} from './import.ts'

const IMPORTER = '10000000-0000-0000-0000-000000000000'
const MANAGER = '10000000-0000-0000-0000-000000000001'
const OWNER = '10000000-0000-0000-0000-000000000002'
const STAFF = '10000000-0000-0000-0000-000000000003'

const baseContext = (): ImportContext => ({
  importerId: IMPORTER,
  people: [
    { id: MANAGER, name: 'Dana Reed', role: 'manager' },
    { id: OWNER, name: 'Sam Lee', role: 'group_owner' },
    { id: STAFF, name: 'Kim Park', role: 'staff' },
  ],
  regions: [{ key: 'national', label: 'National' }],
  existing: { plans: [], actions: [], contacts: [], updates: [] },
})

// ── parseExport ─────────────────────────────────────────────────────────────

test('parseExport refuses non-objects and missing projects', () => {
  assert.equal(parseExport(null).ok, false)
  assert.equal(parseExport([]).ok, false)
  assert.equal(parseExport('x').ok, false)
  assert.equal(parseExport({}).ok, false)
  assert.equal(parseExport({ projects: {} }).ok, false)
})

test('parseExport refuses records without id and duplicate ids', () => {
  const noId = parseExport({ projects: [{ name: 'X' }] })
  assert.equal(noId.ok, false)
  const dup = parseExport({ projects: [{ id: 'a' }, { id: 'a' }] })
  assert.equal(dup.ok, false)
  if (!dup.ok) assert.ok(dup.errors.some((e) => e.includes('more than once')))
})

test('parseExport refuses a list that is not an array', () => {
  const res = parseExport({ projects: [{ id: 'a' }], actions: {} })
  assert.equal(res.ok, false)
})

test('parseExport ignores unknown top-level keys and defaults missing lists', () => {
  const res = parseExport({ projects: [{ id: 'a' }], meta: { x: 1 }, handoverMeta: 5 })
  assert.equal(res.ok, true)
  if (res.ok) {
    assert.equal(res.data.projects.length, 1)
    assert.deepEqual(res.data.actions, [])
    assert.deepEqual(res.data.reviews, [])
  }
})

// ── Helper to parse then translate ─────────────────────────────────────────

function run(raw: unknown, ctx: ImportContext = baseContext()) {
  const parsed = parseExport(raw)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) throw new Error('parse failed')
  return translateExport(parsed.data, ctx)
}

// ── Value maps ──────────────────────────────────────────────────────────────

test('value maps translate old codes to agreed keys', () => {
  const { payload } = run({
    projects: [{ id: 'p1', name: 'Alpha', category: 'product', status: 'on-track' }],
    actions: [{ id: 'a1', title: 'Call', projectId: 'p1', kind: 'meet', status: 'open', priority: 'high' }],
    updates: [{ id: 'u1', projectId: 'p1', text: 'hi', source: 'comment' }],
  })
  assert.equal(payload.plans[0].category, 'product_software')
  assert.equal(payload.plans[0].status, 'on_track')
  assert.equal(payload.actions[0].type, 'meeting')
  assert.equal(payload.actions[0].priority, 'high')
  assert.equal(payload.updates[0].source, 'my_note')
})

test('unmapped value becomes an error', () => {
  const { preview } = run({
    projects: [{ id: 'p1', name: 'Alpha', category: 'mystery' }],
  })
  assert.ok(preview.errors.some((e) => e.includes('mystery')))
})

test('empty strings become null', () => {
  const { payload } = run({
    projects: [{ id: 'p1', name: 'Alpha', client: '', summary: '   ' }],
  })
  assert.equal(payload.plans[0].client, null)
  assert.equal(payload.plans[0].summary, null)
})

test('bad date is an error, good date kept', () => {
  const bad = run({ projects: [{ id: 'p1', name: 'A', updated: '2026-13-40' }] })
  assert.ok(bad.preview.errors.some((e) => e.includes('not a real')))
  const good = run({ projects: [{ id: 'p1', name: 'A', updated: '2026-02-28' }] })
  assert.equal(good.payload.plans[0].updated_on, '2026-02-28')
  assert.equal(good.preview.errors.length, 0)
})

// ── Plans: order, parents ───────────────────────────────────────────────────

test('plan fields map: order→sort_order, parentId→parent_legacy_id', () => {
  const { payload } = run({
    projects: [
      { id: 'parent', name: 'Parent' },
      { id: 'child', name: 'Child', parentId: 'parent', order: 3 },
    ],
  })
  const child = payload.plans.find((p) => p.legacy_id === 'child')!
  assert.equal(child.sort_order, 3)
  assert.equal(child.parent_legacy_id, 'parent')
})

test('parent not in file is an error', () => {
  const { preview } = run({ projects: [{ id: 'c', name: 'C', parentId: 'ghost' }] })
  assert.ok(preview.errors.some((e) => e.includes('ghost')))
})

test('parent already imported is allowed', () => {
  const ctx = baseContext()
  ctx.existing.plans = [{ legacy_id: 'oldparent', owner_id: MANAGER, archived: false }]
  const { preview } = run({ projects: [{ id: 'c', name: 'C', parentId: 'oldparent' }] }, ctx)
  assert.equal(preview.errors.length, 0)
})

test('self-parent is an error', () => {
  const { preview } = run({ projects: [{ id: 'p', name: 'P', parentId: 'p' }] })
  assert.ok(preview.errors.some((e) => e.includes('its own parent')))
})

test('parent loop is an error', () => {
  const { preview } = run({
    projects: [
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' },
    ],
  })
  assert.ok(preview.errors.some((e) => e.includes('loop')))
})

// ── Owner choice ────────────────────────────────────────────────────────────

test('owner defaults to importer, else existing owner, else chosen', () => {
  const ctx = baseContext()
  ctx.existing.plans = [{ legacy_id: 'kept', owner_id: OWNER, archived: false }]
  ctx.owners = { chosen: MANAGER }
  const { payload } = run({
    projects: [
      { id: 'fresh', name: 'Fresh' },
      { id: 'kept', name: 'Kept' },
      { id: 'chosen', name: 'Chosen' },
    ],
  }, ctx)
  const by = (id: string) => payload.plans.find((p) => p.legacy_id === id)!
  assert.equal(by('fresh').owner_id, IMPORTER)
  assert.equal(by('kept').owner_id, OWNER)
  assert.equal(by('chosen').owner_id, MANAGER)
})

test('chosen owner who is not manager/group_owner is an error', () => {
  const ctx = baseContext()
  ctx.owners = { p1: STAFF }
  const { preview } = run({ projects: [{ id: 'p1', name: 'P1' }] }, ctx)
  assert.ok(preview.errors.some((e) => e.includes('Manager or Group Owner')))
})

// ── Regions ─────────────────────────────────────────────────────────────────

test('region reuses a matching label ignoring case/spaces', () => {
  const { payload, preview } = run({
    projects: [{ id: 'p1', name: 'P1', region: '  national ' }],
  })
  assert.equal(payload.plans[0].region, 'national')
  assert.deepEqual(preview.regions_to_add, [])
})

test('new region gets a key from the label, de-duplicated', () => {
  const ctx = baseContext()
  ctx.regions = [{ key: 'example_white_label', label: 'Taken' }]
  const { payload, preview } = run({
    projects: [
      { id: 'p1', name: 'P1', region: 'Example: white label' },
      { id: 'p2', name: 'P2', region: 'Example: white label!' },
    ],
  }, ctx)
  // First makes example_white_label but it's taken → _2; second matches label? no,
  // different label text, so a new key. Both labels listed.
  assert.ok(preview.regions_to_add.includes('Example: white label'))
  const keys = payload.regions.map((r) => r.key)
  assert.ok(keys.includes('example_white_label_2'))
})

// ── Milestones ──────────────────────────────────────────────────────────────

test('milestones: legacy id normalised, repeats numbered, status and order', () => {
  const { payload } = run({
    projects: [{
      id: 'p1', name: 'P1', milestones: [
        { label: 'Kick  Off', date: '2026-01-01', done: true },
        { label: 'kick off', date: '2026-02-01', done: false },
      ],
    }],
  })
  assert.equal(payload.milestones.length, 2)
  assert.equal(payload.milestones[0].legacy_id, 'kick off')
  assert.equal(payload.milestones[0].status, 'completed')
  assert.equal(payload.milestones[0].sort_order, 0)
  assert.equal(payload.milestones[1].legacy_id, 'kick off #2')
  assert.equal(payload.milestones[1].status, 'planned')
  assert.equal(payload.milestones[1].sort_order, 1)
})

// ── Actions: assignee & contact matching ────────────────────────────────────

test('assignee resolves by exact name; ambiguous/none noted', () => {
  const ctx = baseContext()
  ctx.people.push({ id: 'dupe', name: 'Dana Reed', role: 'staff' }) // now two "Dana Reed"
  const { payload, preview } = run({
    projects: [{ id: 'p1', name: 'P1' }],
    actions: [
      { id: 'a1', title: 'One', projectId: 'p1', newOwner: 'Sam Lee' },
      { id: 'a2', title: 'Two', projectId: 'p1', newOwner: 'Dana Reed' },  // ambiguous
      { id: 'a3', title: 'Three', projectId: 'p1', newOwner: 'Nobody' },
    ],
  }, ctx)
  assert.equal(payload.actions[0].assignee_id, OWNER)
  assert.equal(payload.actions[1].assignee_id, null)
  assert.equal(payload.actions[2].assignee_id, null)
  assert.ok(preview.notes.some((n) => n.includes('Dana Reed')))
  assert.ok(preview.notes.some((n) => n.includes('Nobody')))
})

test('contact resolves by matching who name', () => {
  const { payload } = run({
    projects: [{ id: 'p1', name: 'P1' }],
    contacts: [{ id: 'c1', name: 'Jo Blog', projects: ['p1'] }],
    actions: [{ id: 'a1', title: 'Chat', projectId: 'p1', who: 'jo blog' }],
  })
  assert.equal(payload.actions[0].contact_legacy_id, 'c1')
})

// ── Contacts: links kept only to known projects ─────────────────────────────

test('contact keeps only links to projects in file/imported; others noted', () => {
  const { payload, preview } = run({
    projects: [{ id: 'p1', name: 'P1' }],
    contacts: [{ id: 'c1', name: 'Jo', projects: ['p1', 'ghost'] }],
  })
  assert.deepEqual(payload.contacts[0].plan_legacy_ids, ['p1'])
  assert.ok(preview.notes.some((n) => n.includes('ghost')))
})

// ── Updates ─────────────────────────────────────────────────────────────────

test('updates skip empty text (noted), kind update', () => {
  const { payload, preview } = run({
    projects: [{ id: 'p1', name: 'P1' }],
    updates: [
      { id: 'u1', projectId: 'p1', text: 'real', date: '2026-01-01', source: 'email' },
      { id: 'u2', projectId: 'p1', text: '' },
    ],
  })
  assert.equal(payload.updates.length, 1)
  assert.equal(payload.updates[0].kind, 'update')
  assert.ok(preview.notes.some((n) => n.includes('u2')))
})

// ── Handover ────────────────────────────────────────────────────────────────

test('handover builds a single update with ordered sections', () => {
  const { payload, preview } = run({
    projects: [{ id: 'p1', name: 'P1' }],
    handover: [{
      id: 'p1', owner: 'Sam', position: 'Steady', people: 'Team', access: 'Drive',
      firstMoves: 'Email', decisions: '', risks: '', updated: '2026-03-01',
    }],
  })
  const h = payload.updates.find((u) => u.kind === 'handover')!
  assert.equal(h.legacy_id, 'handover:p1')
  assert.equal(h.date, '2026-03-01')
  assert.ok(h.text.startsWith('**Taking over:** Sam'))
  const posIdx = h.text.indexOf('## Where it stands')
  const peopleIdx = h.text.indexOf('## People')
  const accessIdx = h.text.indexOf('## Where things live')
  const firstIdx = h.text.indexOf('## First moves')
  assert.ok(posIdx < peopleIdx && peopleIdx < accessIdx && accessIdx < firstIdx)
  assert.ok(!h.text.includes('## Decisions made')) // empty, skipped
  assert.equal(preview.counts.handover, 1)
})

test('handover with nothing in it is skipped', () => {
  const { payload, preview } = run({
    projects: [{ id: 'p1', name: 'P1' }],
    handover: [{ id: 'p1', owner: '', position: '', people: '', decisions: '', risks: '', access: '', firstMoves: '' }],
  })
  assert.equal(payload.updates.filter((u) => u.kind === 'handover').length, 0)
  assert.equal(preview.counts.handover, 0)
})

// ── Reviews ─────────────────────────────────────────────────────────────────

test('reviews: non-weeks skipped, checks mapped, extras noted, standing notes added', () => {
  const { payload, preview } = run({
    projects: [{ id: 'p1', name: 'P1' }],
    reviews: [
      { id: '2026-W43', checks: { inbox: true, other: true } },
      { id: 'not-a-week', checks: {} },
    ],
  })
  assert.equal(payload.reviews.length, 1)
  assert.deepEqual(payload.reviews[0].checks, { clear_inbox: true })
  assert.ok(preview.notes.some((n) => n.includes('not-a-week')))
  assert.ok(preview.notes.some((n) => n.includes('left out')))
  assert.ok(preview.notes.includes('Weekly reviews are saved as your own.'))
  assert.ok(preview.notes.includes('Imported updates and handover notes show you as the author.'))
})

// ── Counts & re-import ──────────────────────────────────────────────────────

test('counts split new vs existing; re-import shows 0 new', () => {
  const raw = {
    projects: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }],
    actions: [{ id: 'a1', title: 'A', projectId: 'p1' }],
    contacts: [{ id: 'c1', name: 'Jo', projects: ['p1'] }],
    updates: [{ id: 'u1', projectId: 'p1', text: 'hi' }],
  }
  const first = run(raw)
  assert.deepEqual(first.preview.counts.plans, { new: 2, existing: 0 })
  assert.deepEqual(first.preview.counts.actions, { new: 1, existing: 0 })

  const ctx = baseContext()
  ctx.existing.plans = [
    { legacy_id: 'p1', owner_id: IMPORTER, archived: false },
    { legacy_id: 'p2', owner_id: IMPORTER, archived: false },
  ]
  ctx.existing.actions = ['a1']
  ctx.existing.contacts = ['c1']
  ctx.existing.updates = ['u1']
  const second = run(raw, ctx)
  assert.deepEqual(second.preview.counts.plans, { new: 0, existing: 2 })
  assert.deepEqual(second.preview.counts.actions, { new: 0, existing: 1 })
  assert.deepEqual(second.preview.counts.contacts, { new: 0, existing: 1 })
  assert.deepEqual(second.preview.counts.updates, { new: 0, existing: 1 })
})

test('preview plans table shows parent name, owner, is_new, archived', () => {
  const ctx = baseContext()
  ctx.existing.plans = [{ legacy_id: 'child', owner_id: OWNER, archived: true }]
  const { preview } = run({
    projects: [
      { id: 'parent', name: 'Parent Co', category: 'grants' },
      { id: 'child', name: 'Child Co', parentId: 'parent' },
    ],
  }, ctx)
  const child = preview.plans.find((p) => p.legacy_id === 'child')!
  assert.equal(child.parent_name, 'Parent Co')
  assert.equal(child.owner_id, OWNER)
  assert.equal(child.is_new, false)
  assert.equal(child.archived, true)
  const parent = preview.plans.find((p) => p.legacy_id === 'parent')!
  assert.equal(parent.is_new, true)
  assert.equal(parent.archived, false)
})
