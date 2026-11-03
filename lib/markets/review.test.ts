/**
 * Unit tests for the Markets review-queue helpers (MKT-6).
 * ──────────────────────────────────────────────────────────────────────────
 * queueObservation / fetchPendingReviews / updateReviewStatus all talk to the
 * markets_review_queue table. These tests inject a fake Supabase client
 * (matching the narrowed ReviewDbClient surface) so the helpers run WITHOUT a
 * live database: we assert the row shape on queue, the filters applied on fetch
 * (status = 'pending', optional commodity, newest-first ordering), the decision
 * patch on update, and that DB errors are surfaced.
 *
 * Run with: npm run test:markets (node --test --experimental-strip-types).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  queueObservation,
  fetchPendingReviews,
  updateReviewStatus,
  type ReviewDbClient,
  type ReviewQueueEntry,
} from './review.ts'

// ── Fake client for INSERT (queueObservation) ────────────────────────────────

function makeInsertClient(opts?: { error?: { message: string } }) {
  const calls: { row: Record<string, unknown> }[] = []
  const client: ReviewDbClient = {
    from() {
      return {
        insert(values: Record<string, unknown>) {
          calls.push({ row: values })
          return {
            select() {
              return {
                async single() {
                  if (opts?.error) return { data: null, error: opts.error }
                  return {
                    data: {
                      id: 'rq-1',
                      created_at: '2024-01-01T00:00:00Z',
                      reviewed_by: null,
                      reviewed_at: null,
                      review_note: null,
                      ...values,
                    } as ReviewQueueEntry,
                    error: null,
                  }
                },
              }
            },
          }
        },
        select() {
          throw new Error('select not used in this test')
        },
        update() {
          throw new Error('update not used in this test')
        },
      }
    },
  }
  return { client, calls }
}

test('queueObservation stages a pending row, deriving commodity/source from payload', async () => {
  const { client, calls } = makeInsertClient()

  const entry = await queueObservation(
    {
      payload: { geo: 'IND', commodity: 'banana', measure: 'production', season: '2024', value: 1, source: 'faostat_2024' },
      submittedBy: 'importer-1',
    },
    client,
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0].row.status, 'pending')
  assert.equal(calls[0].row.commodity, 'banana')
  assert.equal(calls[0].row.source, 'faostat_2024')
  assert.equal(calls[0].row.submitted_by, 'importer-1')
  assert.deepEqual(
    calls[0].row.payload,
    { geo: 'IND', commodity: 'banana', measure: 'production', season: '2024', value: 1, source: 'faostat_2024' },
  )
  assert.equal(entry.id, 'rq-1')
  assert.equal(entry.status, 'pending')
})

test('queueObservation prefers explicit commodity/source over payload-derived', async () => {
  const { client, calls } = makeInsertClient()

  await queueObservation(
    {
      payload: { commodity: 'banana', source: 'faostat_2024' },
      submittedBy: null,
      commodity: 'mango',
      source: 'custom',
    },
    client,
  )

  assert.equal(calls[0].row.commodity, 'mango')
  assert.equal(calls[0].row.source, 'custom')
  assert.equal(calls[0].row.submitted_by, null)
})

test('queueObservation surfaces a database error', async () => {
  const { client } = makeInsertClient({ error: { message: 'violates not-null' } })
  await assert.rejects(
    () => queueObservation({ payload: {}, submittedBy: null }, client),
    /review-queue insert failed: violates not-null/,
  )
})

// ── Fake client for SELECT (fetchPendingReviews) ─────────────────────────────

function makeSelectClient(rows: ReviewQueueEntry[], opts?: { error?: { message: string } }) {
  const filters: { column: string; value: unknown }[] = []
  const orders: { column: string; ascending: boolean }[] = []

  function builder(): any {
    const chain = {
      eq(column: string, value: unknown) {
        filters.push({ column, value })
        return chain
      },
      order(column: string, o: { ascending: boolean }) {
        orders.push({ column, ascending: o.ascending })
        return chain
      },
      then(resolve: (r: { data: ReviewQueueEntry[] | null; error: unknown }) => unknown) {
        if (opts?.error) return resolve({ data: null, error: opts.error })
        return resolve({ data: rows, error: null })
      },
    }
    return chain
  }

  const client: ReviewDbClient = {
    from() {
      return {
        insert() {
          throw new Error('insert not used in this test')
        },
        select() {
          return builder()
        },
        update() {
          throw new Error('update not used in this test')
        },
      }
    },
  }
  return { client, filters, orders }
}

test('fetchPendingReviews filters to pending and orders newest-first', async () => {
  const seed: ReviewQueueEntry[] = [
    {
      id: 'rq-2', payload: {}, commodity: 'banana', source: null, status: 'pending',
      submitted_by: null, reviewed_by: null, review_note: null,
      created_at: '2024-02-01T00:00:00Z', reviewed_at: null,
    },
  ]
  const { client, filters, orders } = makeSelectClient(seed)

  const out = await fetchPendingReviews(undefined, client)

  assert.deepEqual(filters, [{ column: 'status', value: 'pending' }])
  assert.deepEqual(orders, [{ column: 'created_at', ascending: false }])
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'rq-2')
})

test('fetchPendingReviews adds a commodity filter when supplied', async () => {
  const { client, filters } = makeSelectClient([])
  await fetchPendingReviews('mango', client)
  assert.deepEqual(filters, [
    { column: 'status', value: 'pending' },
    { column: 'commodity', value: 'mango' },
  ])
})

test('fetchPendingReviews surfaces a database error', async () => {
  const { client } = makeSelectClient([], { error: { message: 'boom' } })
  await assert.rejects(() => fetchPendingReviews(undefined, client), /review-queue fetch failed: boom/)
})

// ── Fake client for UPDATE (updateReviewStatus) ──────────────────────────────

function makeUpdateClient(opts?: { error?: { message: string } }) {
  const calls: { patch: Record<string, unknown>; eq: { column: string; value: unknown } }[] = []
  const client: ReviewDbClient = {
    from() {
      return {
        insert() {
          throw new Error('insert not used in this test')
        },
        select() {
          throw new Error('select not used in this test')
        },
        update(values: Record<string, unknown>) {
          return {
            eq(column: string, value: unknown) {
              calls.push({ patch: values, eq: { column, value } })
              return {
                select() {
                  return {
                    async single() {
                      if (opts?.error) return { data: null, error: opts.error }
                      return {
                        data: { id: String(value), ...values } as unknown as ReviewQueueEntry,
                        error: null,
                      }
                    },
                  }
                },
              }
            },
          }
        },
      }
    },
  }
  return { client, calls }
}

test('updateReviewStatus records the decision, reviewer, note and timestamp', async () => {
  const { client, calls } = makeUpdateClient()

  const before = Date.now()
  const entry = await updateReviewStatus(
    { id: 'rq-9', status: 'approved', reviewedBy: 'mgr-1', reviewNote: 'looks good' },
    client,
  )
  const after = Date.now()

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].eq, { column: 'id', value: 'rq-9' })
  assert.equal(calls[0].patch.status, 'approved')
  assert.equal(calls[0].patch.reviewed_by, 'mgr-1')
  assert.equal(calls[0].patch.review_note, 'looks good')
  const ts = new Date(calls[0].patch.reviewed_at as string).getTime()
  assert.ok(ts >= before && ts <= after, 'reviewed_at should be the current time')
  assert.equal(entry.id, 'rq-9')
  assert.equal(entry.status, 'approved')
})

test('updateReviewStatus defaults a missing note to null and surfaces errors', async () => {
  const ok = makeUpdateClient()
  await updateReviewStatus({ id: 'rq-10', status: 'rejected', reviewedBy: null }, ok.client)
  assert.equal(ok.calls[0].patch.review_note, null)
  assert.equal(ok.calls[0].patch.reviewed_by, null)

  const bad = makeUpdateClient({ error: { message: 'no row' } })
  await assert.rejects(
    () => updateReviewStatus({ id: 'x', status: 'approved', reviewedBy: 'm' }, bad.client),
    /review-queue update failed: no row/,
  )
})
