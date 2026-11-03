/**
 * Markets audit-log helpers (MKT-6) — server-side only.
 * ──────────────────────────────────────────────────────────────────────────
 * Appends an IMMUTABLE record of every reference-data change to the
 * `markets_audit` table (migration 075): who changed what, when, on which
 * table / row, and the before / after values. This is the foundation every
 * downstream CRUD, import and publish workflow (MKT-6b through 6f) writes to.
 *
 * The audit log is append-only: the migration grants INSERT + SELECT policies
 * only, so history cannot be rewritten through the authenticated path.
 *
 * ⚠️  Import only in server-side code. Writes use the service-role admin client
 *     by default; route-level role gating authorises the caller. A client may
 *     be injected (e.g. in tests, or to reuse a request-scoped client).
 */

import { createAdminClient } from '../supabase/admin'
import type { SupabaseClient } from '@supabase/supabase-js'

/** The kind of change recorded in the audit log. */
export type MarketsAuditAction = 'insert' | 'update' | 'archive' | 'restore' | 'delete'

/** A single audit-log entry, mirroring the markets_audit table columns. */
export interface MarketsAuditEntry {
  id: string
  actor_id: string | null
  action: MarketsAuditAction
  target_table: string
  row_id: string
  old_value: Record<string, unknown> | null
  new_value: Record<string, unknown> | null
  note: string | null
  created_at: string
}

/** The inputs needed to log a change (id / created_at are assigned by the DB). */
export interface LogChangeInput {
  /** The acting user's id, or null when unknown (e.g. a system / service action). */
  actorId: string | null
  action: MarketsAuditAction
  /** The table that changed, e.g. 'markets_sources'. */
  targetTable: string
  /** The primary key of the changed row, coerced to text. */
  rowId: string | number
  /** Before-image. Omit / null for an insert. */
  oldValue?: Record<string, unknown> | null
  /** After-image. Omit / null for a delete. */
  newValue?: Record<string, unknown> | null
  note?: string | null
}

/**
 * The minimal Supabase surface the audit helpers use. Narrowing to this shape
 * (rather than importing the full SupabaseClient type) keeps the helpers
 * trivially mockable in unit tests without a live database.
 */
export interface AuditDbClient {
  from(table: string): {
    insert(values: Record<string, unknown>): {
      select(columns?: string): {
        single(): Promise<{ data: unknown; error: { message: string } | null }>
      }
    }
  }
}

/**
 * Append one entry to the markets_audit log. Returns the inserted row.
 *
 * Throws if the insert fails — an audit write that silently drops would defeat
 * the log's purpose, so callers in a transactional change path should let the
 * error propagate (or wrap it) rather than swallow it.
 */
export async function logChange(
  input: LogChangeInput,
  client?: AuditDbClient,
): Promise<MarketsAuditEntry> {
  const db = client ?? (createAdminClient() as unknown as AuditDbClient)

  const row = {
    actor_id: input.actorId,
    action: input.action,
    target_table: input.targetTable,
    row_id: String(input.rowId),
    old_value: input.oldValue ?? null,
    new_value: input.newValue ?? null,
    note: input.note ?? null,
  }

  const { data, error } = await db.from('markets_audit').insert(row).select().single()
  if (error) {
    throw new Error(`[markets] audit log insert failed: ${error.message}`)
  }
  return data as MarketsAuditEntry
}

/**
 * Read the most recent reference-data changes from the audit log, newest first.
 * Used by the Markets manage dashboard (MKT-6) to show a recent-changes feed.
 *
 * Pass the request-scoped Supabase client — the markets_audit_read RLS policy
 * (migration 075) lets any Markets viewer+ SELECT the log, so the caller's own
 * client is sufficient and keeps the read honouring RLS.
 *
 * @param client - a request-scoped Supabase client.
 * @param limit  - maximum rows to return (default 20).
 */
export async function fetchRecentAuditChanges(
  client: SupabaseClient,
  limit = 20,
): Promise<MarketsAuditEntry[]> {
  const { data, error } = await client
    .from('markets_audit')
    .select('id, actor_id, action, target_table, row_id, old_value, new_value, note, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    throw new Error(`[markets] audit log read failed: ${error.message}`)
  }
  return (data ?? []) as MarketsAuditEntry[]
}
