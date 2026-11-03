/**
 * Unit tests for the Markets audit-log helper (MKT-6).
 * ──────────────────────────────────────────────────────────────────────────
 * logChange() writes one immutable row to markets_audit. These tests inject a
 * fake Supabase client (matching the narrowed AuditDbClient surface) so the
 * helper is exercised WITHOUT a live database: we assert the exact row shape it
 * builds, the text coercion of row_id, the null defaulting of old/new values,
 * and that a DB error is surfaced rather than swallowed.
 *
 * Run with: npm run test:markets (node --test --experimental-strip-types).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { logChange, type AuditDbClient } from './audit.ts'

/** A fake AuditDbClient that records the inserted row and returns it echoed. */
function makeFakeClient(opts?: { error?: { message: string } }) {
  const calls: { table: string; row: Record<string, unknown> }[] = []
  const client: AuditDbClient = {
    from(table: string) {
      return {
        insert(values: Record<string, unknown>) {
          calls.push({ table, row: values })
          return {
            select() {
              return {
                async single() {
                  if (opts?.error) return { data: null, error: opts.error }
                  return {
                    data: { id: 'audit-1', created_at: '2024-01-01T00:00:00Z', ...values },
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
  return { client, calls }
}

test('logChange writes a well-formed row to markets_audit', async () => {
  const { client, calls } = makeFakeClient()

  const entry = await logChange(
    {
      actorId: 'user-42',
      action: 'update',
      targetTable: 'markets_sources',
      rowId: 'faostat_2024',
      oldValue: { name: 'Old' },
      newValue: { name: 'New' },
      note: 'renamed',
    },
    client,
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0].table, 'markets_audit')
  assert.deepEqual(calls[0].row, {
    actor_id: 'user-42',
    action: 'update',
    target_table: 'markets_sources',
    row_id: 'faostat_2024',
    old_value: { name: 'Old' },
    new_value: { name: 'New' },
    note: 'renamed',
  })
  assert.equal(entry.id, 'audit-1')
  assert.equal(entry.action, 'update')
})

test('logChange coerces a numeric row id to text and defaults null values', async () => {
  const { client, calls } = makeFakeClient()

  await logChange(
    {
      actorId: null,
      action: 'insert',
      targetTable: 'markets_prices',
      rowId: 12345,
    },
    client,
  )

  assert.equal(calls[0].row.row_id, '12345')
  assert.equal(typeof calls[0].row.row_id, 'string')
  assert.equal(calls[0].row.actor_id, null)
  assert.equal(calls[0].row.old_value, null)
  assert.equal(calls[0].row.new_value, null)
  assert.equal(calls[0].row.note, null)
})

test('logChange surfaces a database error instead of swallowing it', async () => {
  const { client } = makeFakeClient({ error: { message: 'permission denied' } })

  await assert.rejects(
    () =>
      logChange(
        { actorId: 'u', action: 'delete', targetTable: 'markets_fx', rowId: 'x' },
        client,
      ),
    /audit log insert failed: permission denied/,
  )
})
