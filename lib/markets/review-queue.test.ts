/**
 * Unit tests for the Markets Review Queue approval helpers (MKT-7b).
 * ──────────────────────────────────────────────────────────────────────────
 * Exercises the pure helpers (parsePending / validateObservation /
 * computeComparison) directly, and the DB-driven helpers (approveEntry,
 * approveEntries, updateReviewEntry, rejectEntry) against an in-memory fake
 * Supabase client that records writes — so they run WITHOUT a live database.
 *
 * The headline test mirrors the MKT-7b acceptance fixture at the unit level:
 * seed a 5-row document to pending, edit one value, approve all, and confirm
 * live observations are created and a pre-existing live figure is marked
 * superseded.
 *
 * Run with: npm run test:markets (node --test --experimental-strip-types).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parsePending,
  validateObservation,
  computeComparison,
  approveEntry,
  approveEntries,
  updateReviewEntry,
  rejectEntry,
  listReviewQueue,
  type ReviewQueueDbClient,
  type LiveObservation,
  type PendingPayload,
} from './review-queue.ts'

// ── In-memory fake Supabase client ───────────────────────────────────────────
// Tables are plain arrays of rows. The builder supports the chainable subset the
// review-queue helpers drive: select/.eq/.in/.is/.order/.range/.limit (thenable),
// insert().select().single(), and update().eq() (thenable). Filters are applied
// in-process over the backing array.

interface Row { [k: string]: unknown }

function makeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {}
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map(r => ({ ...r }))
  let idSeq = 1000

  function selectBuilder(table: string) {
    const filters: Array<(r: Row) => boolean> = []
    const api: Record<string, unknown> = {}
    const build = () => {
      api.eq = (col: string, val: unknown) => { filters.push(r => r[col] === val); return api }
      api.in = (col: string, vals: unknown[]) => { filters.push(r => vals.includes(r[col])); return api }
      api.is = (col: string, val: null) => { filters.push(r => (r[col] ?? null) === val); return api }
      api.order = () => api
      api.range = () => api
      api.limit = () => api
      api.then = (resolve: (r: { data: Row[]; error: null }) => unknown) => {
        const rows = (tables[table] ?? []).filter(r => filters.every(f => f(r)))
        return resolve({ data: rows.map(r => ({ ...r })), error: null })
      }
      return api
    }
    return build()
  }

  const client: ReviewQueueDbClient = {
    from(table: string) {
      return {
        select() {
          return selectBuilder(table)
        },
        insert(values: Row) {
          const id = `id-${idSeq++}`
          const row = { id, ...values }
          tables[table] = tables[table] ?? []
          tables[table].push(row)
          const thenable = {
            select() {
              return { async single() { return { data: { id }, error: null } } }
            },
            then(resolve: (r: { data: null; error: null }) => unknown) {
              return resolve({ data: null, error: null })
            },
          }
          return thenable as unknown as ReturnType<ReturnType<ReviewQueueDbClient['from']>['insert']>
        },
        update(values: Row) {
          return {
            eq(col: string, val: unknown) {
              const rows = (tables[table] ?? []).filter(r => r[col] === val)
              for (const r of rows) Object.assign(r, values)
              return Promise.resolve({ data: null, error: null })
            },
          }
        },
      } as unknown as ReturnType<ReviewQueueDbClient['from']>
    },
  }

  return { client, tables }
}

// The review-queue write helpers route their audit writes through the SAME
// injected client (see audit() in review-queue.ts), so passing this fake keeps
// every test DB-free — createAdminClient() is never reached. Audit inserts land
// generically via from('markets_audit').insert(), handled by the insert branch
// above (we don't assert on the audit rows here; audit.test.ts covers logChange).

// ── Pure helpers ──────────────────────────────────────────────────────────────

test('parsePending derives mapping_status from both reference ids', () => {
  const matched = parsePending({ commodity: 'banana', geo: 'IND', measure: 'production', season: '2024', value: 10 })
  assert.equal(matched.mapping_status, 'matched')
  const unmatched = parsePending({ commodity: 'banana', geo: null, measure: 'production', season: '2024', value: 10 })
  assert.equal(unmatched.mapping_status, 'unmatched')
})

test('validateObservation rejects null commodity / geo and missing fields', () => {
  const bad = validateObservation(parsePending({ value: 1 }))
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.some(e => /Commodity/.test(e)))
  assert.ok(bad.errors.some(e => /Geograph/.test(e)))

  const good = validateObservation(parsePending({
    commodity: 'banana', geo: 'IND', measure: 'production', season: '2024', value: 1,
  }))
  assert.deepEqual(good, { ok: true, errors: [] })
})

test('computeComparison flags >10% value diffs and confidence drops', () => {
  const live: LiveObservation = {
    id: 'o1', geo: 'IND', commodity: 'banana', measure: 'production',
    season: '2024', value: 100, unit: 't', source: null, confidence: 'high',
  }
  const big = computeComparison(
    parsePending({ value: 120, confidence: 'high' }), live,
  )
  assert.equal(big.largeDiff, true)
  assert.equal(Math.round(big.percentDiff ?? -1), 20)

  const small = computeComparison(parsePending({ value: 105, confidence: 'high' }), live)
  assert.equal(small.largeDiff, false)

  const confDrop = computeComparison(parsePending({ value: 100, confidence: 'low' }), live)
  assert.equal(confDrop.confidenceMismatch, true)

  const noLive = computeComparison(parsePending({ value: 100 }), null)
  assert.equal(noLive.live, null)
  assert.equal(noLive.largeDiff, false)
})

// ── DB-driven helpers (injected fake client) ──────────────────────────────────

/** Build a 5-row pending fixture for one document. */
function fiveRowFixture(): Row[] {
  const base = (i: number, overrides: Partial<PendingPayload> = {}): Row => ({
    id: `rq-${i}`,
    status: 'pending',
    commodity: 'banana',
    source: 'faostat_2024',
    submitted_by: 'importer-1',
    reviewed_by: null,
    review_note: null,
    created_at: `2024-01-0${i}T00:00:00Z`,
    reviewed_at: null,
    payload: {
      geo: 'IND', geo_label: 'India', commodity: 'banana', commodity_label: 'Banana',
      measure: 'production', season: '2024', value: i * 10, unit: 't',
      source: 'faostat_2024', confidence: 'medium', method: 'spreadsheet_extract',
      note: null, mapping_status: 'matched',
      document_id: 'doc-1', document_name: 'india_bananas.xlsx',
      ...overrides,
    },
  })
  return [
    base(1, { measure: 'production' }),
    base(2, { measure: 'export_volume' }),
    base(3, { measure: 'import_volume' }),
    base(4, { measure: 'yield' }),
    base(5, { measure: 'area_harvested' }),
  ]
}

test('listReviewQueue returns pending entries with counts + live comparison', async () => {
  const { client } = makeDb({
    markets_review_queue: fiveRowFixture(),
    markets_observations: [
      { id: 'o-prod', geo: 'IND', commodity: 'banana', measure: 'production', season: '2024', value: 5, unit: 't', source: null, confidence: 'high', archived_at: null, superseded_at: null },
    ],
  })

  const res = await listReviewQueue({ status: 'pending' }, client)
  assert.equal(res.total, 5)
  assert.equal(res.counts.pending, 5)
  assert.equal(res.entries.length, 5)

  const prod = res.entries.find(e => e.payload.measure === 'production')
  assert.ok(prod)
  assert.ok(prod!.comparison.live, 'production row should match a live figure')
  // value 10 vs live 5 → 100% diff → largeDiff
  assert.equal(prod!.comparison.largeDiff, true)

  const other = res.entries.find(e => e.payload.measure === 'yield')
  assert.equal(other!.comparison.live, null)
})

test('listReviewQueue search filters by commodity / geo / filename', async () => {
  const { client } = makeDb({
    markets_review_queue: fiveRowFixture(),
    markets_observations: [],
  })
  const hit = await listReviewQueue({ status: 'pending', search: 'india_bananas' }, client)
  assert.equal(hit.total, 5)
  const miss = await listReviewQueue({ status: 'pending', search: 'coffee' }, client)
  assert.equal(miss.total, 0)
})

test('approveEntry rejects an unmapped entry without writing an observation', async () => {
  const { client, tables } = makeDb({
    markets_review_queue: [{
      id: 'rq-x', status: 'pending', commodity: null, source: null,
      submitted_by: null, reviewed_by: null, review_note: null,
      created_at: '2024-01-01T00:00:00Z', reviewed_at: null,
      payload: { commodity: null, geo: 'IND', measure: 'production', season: '2024', value: 1 },
    }],
    markets_observations: [],
    markets_audit: [],
  })
  const res = await approveEntry('rq-x', 'mgr-1', client)
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /Commodity/)
  assert.equal((tables.markets_observations ?? []).length, 0)
  // queue row stays pending
  assert.equal(tables.markets_review_queue[0].status, 'pending')
})

test('ACCEPTANCE: edit one value, approve all 5 → live created, prior figure superseded', async () => {
  const { client, tables } = makeDb({
    markets_review_queue: fiveRowFixture(),
    // A pre-existing live figure for the production key that must be superseded.
    markets_observations: [
      { id: 'o-prod-old', geo: 'IND', commodity: 'banana', measure: 'production', season: '2024', value: 5, unit: 't', source: null, confidence: 'high', archived_at: null, superseded_at: null, superseded_by: null },
    ],
    markets_audit: [],
  })

  // Edit one value (the production row: 10 → 42).
  const edited = await updateReviewEntry('rq-1', { value: 42 }, 'mgr-1', client)
  assert.equal(edited.value, 42)
  assert.equal(edited.mapping_status, 'matched')

  // Approve all five.
  const results = await approveEntries(['rq-1', 'rq-2', 'rq-3', 'rq-4', 'rq-5'], 'mgr-1', client)
  assert.equal(results.length, 5)
  assert.ok(results.every(r => r.ok), 'all five should approve: ' + JSON.stringify(results))

  // Five new live observations inserted (one per measure).
  const live = (tables.markets_observations ?? []).filter(o => (o.superseded_at ?? null) === null)
  assert.equal(live.length, 5, 'exactly five current live observations')

  // The edited production value is live as 42.
  const prod = live.find(o => o.measure === 'production')
  assert.equal(prod!.value, 42)

  // The prior production figure is now superseded, pointing at the approving entry.
  const old = (tables.markets_observations ?? []).find(o => o.id === 'o-prod-old')
  assert.ok(old!.superseded_at, 'old production figure should be superseded')
  assert.equal(old!.superseded_by, 'rq-1')

  // All queue rows are approved.
  assert.ok(tables.markets_review_queue.every(r => r.status === 'approved'))

  // The production approval reports the supersede.
  const prodResult = results.find(r => r.id === 'rq-1')
  assert.equal(prodResult!.supersededId, 'o-prod-old')
})

test('rejectEntry marks the row rejected with a reason', async () => {
  const { client, tables } = makeDb({
    markets_review_queue: [{
      id: 'rq-9', status: 'pending', commodity: 'banana', source: null,
      submitted_by: null, reviewed_by: null, review_note: null,
      created_at: '2024-01-01T00:00:00Z', reviewed_at: null,
      payload: { commodity: 'banana', geo: 'IND', measure: 'production', season: '2024', value: 1 },
    }],
    markets_audit: [],
  })
  await rejectEntry('rq-9', 'duplicate', 'mgr-1', client)
  assert.equal(tables.markets_review_queue[0].status, 'rejected')
  assert.equal(tables.markets_review_queue[0].review_note, 'duplicate')
})
