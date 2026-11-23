/**
 * Unit tests for lib/tracker/import.ts (P4).
 * Run: npm run test:tracker
 *
 * The file below is made up: it has the previous tracker's shape, not its data.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  type ImportContext, type OldExport,
  dateOrNull, keyFromLabel, parseExport, translateExport,
} from './import.ts'

const ME = '00000000-0000-0000-0000-000000000001'
const OWNER = '00000000-0000-0000-0000-000000000002'
const STAFF = '00000000-0000-0000-0000-000000000003'

const FILE = {
  meta: { name: 'Sample' },
  projects: [
    { id: 'p-1', name: 'Alpha', category: 'data', status: 'on-track', client: 'Client One', phase: '',
      summary: 'Line one\nLine two', folder: '', order: 0, updated: '2026-10-19',
      milestones: [
        { label: 'First sample', date: '2026-11-02', done: true },
        { label: 'Final report', date: '2027-06-14', done: false },
        { label: 'final  report', date: '2027-07-01', done: false },
      ] },
    { id: 'p-2', name: 'Alpha North', category: 'trials', status: 'waiting', order: 1, updated: '2026-11-13',
      parentId: 'p-3', region: 'Far North', milestones: [] },
    { id: 'p-3', name: 'Beta', category: 'pipeline', status: 'proposal', order: 2, updated: '2026-11-16' },
  ],
  actions: [
    { id: 'a-1', title: 'Write the report', projectId: 'p-1', kind: 'do', who: '', due: '', status: 'open',
      priority: 'normal', notes: '', created: '2026-10-21', waitingSince: '', doneOn: '', newOwner: 'Sam Staff' },
    { id: 'a-2', title: 'Get site locations', projectId: 'p-2', kind: 'chase', who: 'Pat Example', due: '2026-11-08',
      status: 'waiting', priority: 'high', notes: 'Asked twice', created: '2026-10-19', waitingSince: '2026-11-03',
      doneOn: '', newOwner: 'Nobody Here', noHandover: true },
    { id: 'a-3', title: 'Discovery meeting', projectId: 'p-3', kind: 'meet', who: 'Org Two', due: '2026-11-02',
      status: 'done', priority: 'normal', created: '2026-10-27', doneOn: '2026-11-04' },
  ],
  contacts: [
    { id: 'c-1', name: 'Pat Example', org: 'Org One', role: 'Agronomist', phone: '', email: 'pat@example.test',
      projects: ['p-1', 'p-2', 'p-9'], lastContact: '2026-11-04', notes: '' },
    { id: 'c-2', name: 'Org Two', org: 'Org Two', projects: ['p-3'], lastContact: '' },
  ],
  updates: [
    { id: 'u-1', projectId: 'p-1', date: '2026-11-04', source: 'call', text: 'Call notes' },
    { id: 'u-2', projectId: 'p-1', date: '2026-10-07', source: 'file', text: 'Saved the guide' },
    { id: 'u-3', projectId: 'p-3', date: '2026-10-21', source: 'comment', text: '   ' },
  ],
  handover: [
    { id: 'p-1', owner: 'Robin Owner', position: 'On track.', firstMoves: '1. Call Pat.', updated: '2026-11-05' },
    { id: 'p-3', owner: '', updated: '2026-11-05' },
  ],
  reviews: [{ id: '2026-W43', checks: { inbox: false, someOldStep: true } }],
}

function context(over: Partial<ImportContext> = {}): ImportContext {
  return {
    importerId: ME,
    people: [
      { id: ME, name: 'Morgan Manager', role: 'manager' },
      { id: OWNER, name: 'Olive Owner', role: 'group_owner' },
      { id: STAFF, name: 'Sam Staff', role: 'staff' },
    ],
    regions: [],
    existing: { plans: [], actions: [], contacts: [], updates: [] },
    ...over,
  }
}

function parsed(raw: unknown = FILE): OldExport {
  const r = parseExport(raw)
  assert.ok(r.ok, r.ok ? '' : r.errors.join('; '))
  return r.data
}

test('parseExport rejects files without the old shape', () => {
  assert.equal(parseExport(null).ok, false)
  assert.equal(parseExport([]).ok, false)
  assert.equal(parseExport({ items: [] }).ok, false)
  const dup = parseExport({ projects: [{ id: 'p-1' }, { id: 'p-1' }] })
  assert.equal(dup.ok, false)
  const noId = parseExport({ projects: [{ name: 'x' }] })
  assert.equal(noId.ok, false)
  assert.equal(parseExport({ projects: [] }).ok, true)
})

test('values map to the agreed keys', () => {
  const { payload, preview } = translateExport(parsed(), context())
  assert.deepEqual(preview.errors, [])
  assert.deepEqual(payload.plans.map((p) => [p.category, p.status]), [
    ['data_science_ci', 'on_track'],
    ['partners_field_trials', 'waiting_on_others'],
    ['proposals_pipeline', 'proposal_pre_contract'],
  ])
  assert.deepEqual(payload.actions.map((a) => a.type), ['do', 'chase', 'meeting'])
  assert.deepEqual(payload.updates.filter((u) => u.kind === 'update').map((u) => u.source), ['call', 'file_folder'])
  assert.deepEqual(payload.reviews, [{ iso_week: '2026-W43', checks: { clear_inbox: false } }])
})

test('plans: owner, parent, region, empty text, dates', () => {
  const { payload, preview } = translateExport(parsed(), context({ owners: { 'p-3': OWNER } }))
  const [p1, p2, p3] = payload.plans
  assert.equal(p1.owner_id, ME)
  assert.equal(p3.owner_id, OWNER)
  assert.equal(p2.parent_legacy_id, 'p-3')
  assert.equal(p2.region, 'far_north')
  assert.deepEqual(payload.regions, [{ key: 'far_north', label: 'Far North' }])
  assert.deepEqual(preview.regions_to_add, ['Far North'])
  assert.equal(p1.phase, null)
  assert.equal(p1.summary, 'Line one\nLine two')
  assert.equal(p1.updated_on, '2026-10-19')
  assert.equal(preview.plans[1].parent_name, 'Beta')
})

test('an existing region is reused by its label', () => {
  const { payload } = translateExport(parsed(), context({ regions: [{ key: 'fn', label: 'far north' }] }))
  assert.equal(payload.plans[1].region, 'fn')
  assert.deepEqual(payload.regions, [])
})

test('only a Manager or Group Owner can be chosen as owner', () => {
  const { preview } = translateExport(parsed(), context({ owners: { 'p-1': STAFF } }))
  assert.equal(preview.errors.length, 1)
  assert.match(preview.errors[0], /owner must be a Manager or Group Owner/)
})

test('milestones are known by their title; done becomes completed', () => {
  const { payload } = translateExport(parsed(), context())
  assert.deepEqual(payload.milestones.map((m) => [m.legacy_id, m.status, m.sort_order]), [
    ['first sample', 'completed', 0],
    ['final report', 'planned', 1],
    ['final report #2', 'planned', 2],
  ])
})

test('actions: assignee from the new owner, contact from who, blanks are null', () => {
  const { payload, preview } = translateExport(parsed(), context())
  const [a1, a2, a3] = payload.actions
  assert.equal(a1.assignee_id, STAFF)
  assert.equal(a1.due_on, null)
  assert.equal(a1.who, null)
  assert.equal(a2.assignee_id, null)
  assert.equal(a2.contact_legacy_id, 'c-1')
  assert.equal(a2.waiting_since, '2026-11-03')
  assert.equal(a3.contact_legacy_id, 'c-2')
  assert.equal(a3.done_on, '2026-11-04')
  assert.ok(preview.notes.some((n) => n.includes('Nobody Here')))
  assert.ok(!JSON.stringify(payload).includes('noHandover'))
})

test('contacts keep only links to projects in the file', () => {
  const { payload, preview } = translateExport(parsed(), context())
  assert.deepEqual(payload.contacts[0].plan_legacy_ids, ['p-1', 'p-2'])
  assert.equal(payload.contacts[1].last_contact, null)
  assert.ok(preview.notes.some((n) => n.includes('"p-9"')))
})

test('empty updates are left out; handover notes become handover updates', () => {
  const { payload, preview } = translateExport(parsed(), context())
  assert.deepEqual(payload.updates.filter((u) => u.kind === 'update').map((u) => u.legacy_id), ['u-1', 'u-2'])
  const h = payload.updates.filter((u) => u.kind === 'handover')
  assert.equal(h.length, 1)
  assert.equal(h[0].legacy_id, 'handover:p-1')
  assert.equal(h[0].date, '2026-11-05')
  assert.equal(h[0].text, '**Taking over:** Robin Owner\n\n## Where it stands\nOn track.\n\n## First moves\n1. Call Pat.')
  assert.equal(preview.counts.handover, 1)
})

test('counts split new from already imported', () => {
  const { preview } = translateExport(parsed(), context({
    existing: {
      plans: [{ legacy_id: 'p-1', owner_id: OWNER, archived: true }],
      actions: ['a-1', 'a-2'], contacts: [], updates: ['u-1'],
    },
  }))
  assert.deepEqual(preview.counts.plans, { new: 2, existing: 1 })
  assert.deepEqual(preview.counts.actions, { new: 1, existing: 2 })
  assert.deepEqual(preview.counts.updates, { new: 1, existing: 1 })
  assert.equal(preview.counts.milestones, 3)
  assert.equal(preview.plans[0].owner_id, OWNER)
  assert.equal(preview.plans[0].archived, true)
})

test('problems stop the import', () => {
  const bad = structuredClone(FILE) as typeof FILE & Record<string, unknown>
  bad.projects[0].category = 'unknown'
  bad.projects[2].parentId = 'p-2'
  bad.actions[0].projectId = 'p-404'
  bad.actions[1].due = '2026-13-40'
  bad.updates[0].source = 'fax'
  const { preview } = translateExport(parsed(bad), context())
  const all = preview.errors.join('\n')
  assert.match(all, /unknown category "unknown"/)
  assert.match(all, /inside one of its own sub-projects/)
  assert.match(all, /project "p-404" isn't in the file/)
  assert.match(all, /"2026-13-40" isn't a date/)
  assert.match(all, /unknown source "fax"/)
})

test('helpers', () => {
  assert.equal(dateOrNull(''), null)
  assert.equal(dateOrNull('2026-02-30'), undefined)
  assert.equal(dateOrNull('2026-02-28'), '2026-02-28')
  assert.equal(keyFromLabel('Example: white label'), 'example_white_label')
})
