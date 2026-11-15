/**
 * Markets Review Queue — approval helpers (MKT-7b) — server-side only.
 * ──────────────────────────────────────────────────────────────────────────
 * The central hub where PENDING observations staged by document extraction
 * (MKT-7a) and template import (MKT-6.5) are validated, corrected and PROMOTED
 * into the live markets_observations fact table. Builds on the MKT-6 primitives
 * in ./review (queueObservation / fetchPendingReviews / updateReviewStatus) and
 * adds the richer surface the Manager approval UI needs:
 *
 *   • listReviewQueue   — status-filtered, searchable, paginated queue read,
 *                         with per-status counts, enriched with the live figure
 *                         for the same (geo, commodity, measure, season) so the
 *                         reviewer can see a side-by-side comparison + diff.
 *   • updateReviewEntry — edit a pending entry's payload (value / unit /
 *                         commodity / geo / measure / season / source / note)
 *                         and recompute its mapping status.
 *   • approveEntries    — promote one or many entries: insert the live
 *                         observation, mark any prior live figure SUPERSEDED,
 *                         flip the queue row to 'approved', and audit-log each
 *                         step. Validation rejects a null commodity / geo id.
 *   • rejectEntry       — reject with an optional reason.
 *   • deferEntry        — park an entry back to 'pending' with a note.
 *
 * Pure helpers (validateObservation, parsePending, computeComparison) are
 * exported so they can be unit-tested WITHOUT a live database.
 *
 * ⚠️  Import only in server-side code. Writes use the service-role admin client
 *     by default; route-level role gating authorises the caller. A client may be
 *     injected (tests / request-scoped client).
 */

import { createAdminClient } from '../supabase/admin'
import { logChange, type AuditDbClient, type LogChangeInput } from './audit'
import type {
  ReviewStatus,
  ReviewQueueEntry,
} from './review'

// Re-export so API routes / UI can import the status union from this module.
export type { ReviewStatus } from './review'

// ── Parsed payload shape ────────────────────────────────────────────────────

/**
 * The reviewer-facing fields of a pending observation, parsed out of the queue
 * row's `payload` JSONB. Mirrors the extractor's PendingObservation (MKT-7a) but
 * is defined independently here so this module does not depend on the extractor.
 */
export interface PendingPayload {
  geo: string | null
  geo_label: string | null
  commodity: string | null
  commodity_label: string | null
  measure: string | null
  season: string | null
  value: number | null
  unit: string | null
  source: string | null
  confidence: string | null
  method: string | null
  note: string | null
  mapping_status: 'matched' | 'unmatched'
  suggestions?: { commodity?: string | null; geo?: string | null }
  /** Originating document id, when the entry came from document extraction. */
  document_id?: string | null
  /** Originating document filename, for grouping / display. */
  document_name?: string | null
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length ? t : null
}

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/**
 * Parse a queue row's JSONB payload into the typed PendingPayload. Unknown /
 * missing fields default to null; mapping_status is recomputed from the
 * presence of both reference ids so an edited row reflects reality.
 */
export function parsePending(payload: Record<string, unknown>): PendingPayload {
  const commodity = str(payload.commodity)
  const geo = str(payload.geo)
  const mapping_status: PendingPayload['mapping_status'] =
    commodity && geo ? 'matched' : 'unmatched'
  const suggestionsRaw = payload.suggestions
  const suggestions =
    suggestionsRaw && typeof suggestionsRaw === 'object'
      ? {
          commodity: str((suggestionsRaw as Record<string, unknown>).commodity),
          geo: str((suggestionsRaw as Record<string, unknown>).geo),
        }
      : undefined

  return {
    geo,
    geo_label: str(payload.geo_label),
    commodity,
    commodity_label: str(payload.commodity_label),
    measure: str(payload.measure),
    season: str(payload.season),
    value: numOrNull(payload.value),
    unit: str(payload.unit),
    source: str(payload.source),
    confidence: str(payload.confidence),
    method: str(payload.method),
    note: str(payload.note),
    mapping_status,
    suggestions,
    document_id: str(payload.document_id),
    document_name: str(payload.document_name),
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

/**
 * Validate that a pending payload can be promoted to a live observation. The
 * markets_observations table requires NOT NULL geo / commodity / measure /
 * season / value, so a promotable entry must carry all five; commodity and geo
 * must additionally be resolved reference ids (a null commodity_id / geo_id is
 * rejected per the MKT-7b brief).
 */
export function validateObservation(p: PendingPayload): ValidationResult {
  const errors: string[] = []
  if (!p.commodity) errors.push('Commodity is unmapped — pick or quick-add a commodity.')
  if (!p.geo) errors.push('Geography is unmapped — resolve it to a known geo unit.')
  if (!p.measure) errors.push('Measure is required.')
  if (!p.season) errors.push('Season is required.')
  if (p.value === null) errors.push('A numeric value is required.')
  return { ok: errors.length === 0, errors }
}

// ── Live comparison + diff ──────────────────────────────────────────────────

/** A live observation row used for the side-by-side comparison. */
export interface LiveObservation {
  id: string
  geo: string
  commodity: string
  measure: string
  season: string
  value: number
  unit: string | null
  source: string | null
  confidence: string | null
}

export interface Comparison {
  /** The current live figure for the same key, if one exists. */
  live: LiveObservation | null
  /** Absolute percentage difference vs the live value, or null if incomparable. */
  percentDiff: number | null
  /** True when the extracted figure differs from live by more than 10%. */
  largeDiff: boolean
  /** True when confidence dropped relative to the live figure (e.g. high→low). */
  confidenceMismatch: boolean
}

const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 }

/**
 * Compare a pending payload against its matching live observation (if any).
 * Flags a "large diff" when the values differ by more than 10%, and a
 * "confidence mismatch" when the pending figure is less confident than live.
 */
export function computeComparison(p: PendingPayload, live: LiveObservation | null): Comparison {
  if (!live) {
    return { live: null, percentDiff: null, largeDiff: false, confidenceMismatch: false }
  }
  let percentDiff: number | null = null
  let largeDiff = false
  if (p.value !== null && Number.isFinite(live.value)) {
    if (live.value === 0) {
      percentDiff = p.value === 0 ? 0 : 100
    } else {
      percentDiff = Math.abs((p.value - live.value) / live.value) * 100
    }
    largeDiff = percentDiff > 10
  }
  const pRank = CONFIDENCE_RANK[p.confidence ?? ''] ?? 0
  const lRank = CONFIDENCE_RANK[live.confidence ?? ''] ?? 0
  const confidenceMismatch = pRank > 0 && lRank > 0 && pRank < lRank
  return { live, percentDiff, largeDiff, confidenceMismatch }
}

// ── Narrowed Supabase surface (mockable in tests) ───────────────────────────

export interface QResult<T> {
  data: T | null
  error: { message: string } | null
}

/** A chainable, thenable select builder (subset of supabase-js). */
export interface SelectBuilder<T> extends PromiseLike<QResult<T[]>> {
  eq(column: string, value: unknown): SelectBuilder<T>
  in(column: string, values: unknown[]): SelectBuilder<T>
  is(column: string, value: null): SelectBuilder<T>
  order(column: string, opts: { ascending: boolean }): SelectBuilder<T>
  range(from: number, to: number): SelectBuilder<T>
  limit(n: number): SelectBuilder<T>
}

export interface UpdateBuilder {
  eq(column: string, value: unknown): PromiseLike<QResult<unknown>>
}

export interface InsertSingle<T> {
  select(columns?: string): { single(): Promise<QResult<T>> }
}

export interface ReviewQueueDbClient {
  from(table: string): {
    select(columns?: string, opts?: { count?: 'exact'; head?: boolean }): SelectBuilder<Record<string, unknown>>
    insert(values: Record<string, unknown>): InsertSingle<Record<string, unknown>> & PromiseLike<QResult<unknown>>
    update(values: Record<string, unknown>): UpdateBuilder
  }
}

function resolveClient(client?: ReviewQueueDbClient): ReviewQueueDbClient {
  return client ?? (createAdminClient() as unknown as ReviewQueueDbClient)
}

/**
 * Write an audit entry, routing through the INJECTED client when one is supplied
 * (so tests stay DB-free) and otherwise letting logChange use the admin client.
 * The narrowed ReviewQueueDbClient.insert surface (from().insert().select()
 * .single()) is a superset of AuditDbClient, so it is safe to reuse.
 */
async function audit(input: LogChangeInput, client?: ReviewQueueDbClient): Promise<void> {
  await logChange(input, client as unknown as AuditDbClient | undefined)
}

// ── List + counts ────────────────────────────────────────────────────────────

export interface ReviewQueueFilter {
  /** 'all' lists every status; otherwise scope to one status. */
  status?: ReviewStatus | 'all'
  /** Free-text search over commodity / geo / filename / uploader email. */
  search?: string
  /** 1-based page number (50 rows/page). */
  page?: number
  /** Rows per page (default 50). */
  pageSize?: number
}

/** A queue entry enriched for the reviewer UI. */
export interface EnrichedEntry {
  id: string
  status: ReviewStatus
  commodity: string | null
  source: string | null
  submitted_by: string | null
  submitter_email: string | null
  reviewed_by: string | null
  review_note: string | null
  created_at: string
  reviewed_at: string | null
  payload: PendingPayload
  comparison: Comparison
}

export interface ReviewQueueCounts {
  pending: number
  approved: number
  rejected: number
}

export interface ReviewQueueResult {
  entries: EnrichedEntry[]
  counts: ReviewQueueCounts
  page: number
  pageSize: number
  total: number
}

export const DEFAULT_PAGE_SIZE = 50

/**
 * Read the review queue: status-filtered, searchable and paginated, with
 * per-status counts and each entry enriched with its live comparison. Search
 * matches commodity / geo id or label / document filename, case-insensitively,
 * performed in-process over the paged set (the queue is a bounded corpus).
 */
export async function listReviewQueue(
  filter: ReviewQueueFilter = {},
  client?: ReviewQueueDbClient,
): Promise<ReviewQueueResult> {
  const db = resolveClient(client)
  const status = filter.status ?? 'pending'
  const page = Math.max(1, filter.page ?? 1)
  const pageSize = Math.max(1, filter.pageSize ?? DEFAULT_PAGE_SIZE)
  const search = (filter.search ?? '').trim().toLowerCase()

  // Counts per status (cheap grouped reads).
  const counts = await fetchCounts(db)

  // Fetch the rows for the requested status, newest first. We over-fetch when
  // searching (search filters in-process) but cap generously.
  let q = db.from('markets_review_queue').select('*')
  if (status !== 'all') q = q.eq('status', status)
  q = q.order('created_at', { ascending: false })
  const { data, error } = await q
  if (error) throw new Error(`[markets] review queue list failed: ${error.message}`)

  const rows = (data ?? []) as unknown as ReviewQueueEntry[]
  const parsed = rows.map(r => ({ row: r, payload: parsePending(r.payload ?? {}) }))

  const filtered = search
    ? parsed.filter(({ row, payload }) => {
        const hay = [
          payload.commodity, payload.commodity_label,
          payload.geo, payload.geo_label,
          payload.document_name, row.source,
        ].filter(Boolean).join(' ').toLowerCase()
        return hay.includes(search)
      })
    : parsed

  const total = filtered.length
  const start = (page - 1) * pageSize
  const pageRows = filtered.slice(start, start + pageSize)

  // Enrich only the current page with live comparisons. Submitter emails are
  // resolved by the API route (which owns the auth-admin client); the library
  // leaves submitter_email null so it stays trivially unit-testable.
  const live = await fetchLiveFor(db, pageRows.map(p => p.payload))

  const entries: EnrichedEntry[] = pageRows.map(({ row, payload }) => {
    const key = obsKey(payload)
    const liveObs = key ? live.get(key) ?? null : null
    return {
      id: row.id,
      status: row.status,
      commodity: row.commodity,
      source: row.source,
      submitted_by: row.submitted_by,
      submitter_email: null,
      reviewed_by: row.reviewed_by,
      review_note: row.review_note,
      created_at: row.created_at,
      reviewed_at: row.reviewed_at,
      payload,
      comparison: computeComparison(payload, liveObs),
    }
  })

  return { entries, counts, page, pageSize, total }
}

async function fetchCounts(db: ReviewQueueDbClient): Promise<ReviewQueueCounts> {
  const counts: ReviewQueueCounts = { pending: 0, approved: 0, rejected: 0 }
  const statuses: ReviewStatus[] = ['pending', 'approved', 'rejected']
  await Promise.all(statuses.map(async s => {
    const { data } = await db.from('markets_review_queue').select('id').eq('status', s)
    counts[s] = (data ?? []).length
  }))
  return counts
}

/** The composite key identifying an observation: geo|commodity|measure|season. */
function obsKey(p: Pick<PendingPayload, 'geo' | 'commodity' | 'measure' | 'season'>): string | null {
  if (!p.geo || !p.commodity || !p.measure || !p.season) return null
  return `${p.geo}|${p.commodity}|${p.measure}|${p.season}`
}

/** Load the current live observation for each distinct, fully-keyed payload. */
async function fetchLiveFor(
  db: ReviewQueueDbClient,
  payloads: PendingPayload[],
): Promise<Map<string, LiveObservation>> {
  const commodities = Array.from(
    new Set(payloads.map(p => p.commodity).filter((c): c is string => !!c)),
  )
  const out = new Map<string, LiveObservation>()
  if (commodities.length === 0) return out

  const { data } = await db
    .from('markets_observations')
    .select('id, geo, commodity, measure, season, value, unit, source, confidence')
    .in('commodity', commodities)
    .is('archived_at', null)
    .is('superseded_at', null)

  for (const r of (data ?? []) as unknown as LiveObservation[]) {
    const key = `${r.geo}|${r.commodity}|${r.measure}|${r.season}`
    out.set(key, r)
  }
  return out
}

// ── Edit a pending entry ─────────────────────────────────────────────────────

export interface EditableFields {
  value?: number | null
  unit?: string | null
  commodity?: string | null
  geo?: string | null
  measure?: string | null
  season?: string | null
  source?: string | null
  note?: string | null
  commodity_label?: string | null
  geo_label?: string | null
}

/**
 * Apply a reviewer's edits to a pending entry's payload. Only the editable
 * fields are touched; mapping_status is recomputed. Returns the updated,
 * re-parsed payload. Throws if the entry is not pending or the write fails.
 */
export async function updateReviewEntry(
  id: string,
  edits: EditableFields,
  actorId: string | null,
  client?: ReviewQueueDbClient,
): Promise<PendingPayload> {
  const db = resolveClient(client)

  const { data: rows, error: readErr } = await db
    .from('markets_review_queue')
    .select('*')
    .eq('id', id)
  if (readErr) throw new Error(`[markets] review entry read failed: ${readErr.message}`)
  const current = (rows ?? [])[0] as unknown as ReviewQueueEntry | undefined
  if (!current) throw new Error(`[markets] review entry ${id} not found`)
  if (current.status !== 'pending') {
    throw new Error(`[markets] review entry ${id} is ${current.status}; only pending entries can be edited`)
  }

  const prev = parsePending(current.payload ?? {})
  const next: PendingPayload = {
    ...prev,
    value: edits.value !== undefined ? edits.value : prev.value,
    unit: edits.unit !== undefined ? edits.unit : prev.unit,
    commodity: edits.commodity !== undefined ? edits.commodity : prev.commodity,
    geo: edits.geo !== undefined ? edits.geo : prev.geo,
    measure: edits.measure !== undefined ? edits.measure : prev.measure,
    season: edits.season !== undefined ? edits.season : prev.season,
    source: edits.source !== undefined ? edits.source : prev.source,
    note: edits.note !== undefined ? edits.note : prev.note,
    commodity_label: edits.commodity_label !== undefined ? edits.commodity_label : prev.commodity_label,
    geo_label: edits.geo_label !== undefined ? edits.geo_label : prev.geo_label,
  }
  next.mapping_status = next.commodity && next.geo ? 'matched' : 'unmatched'

  const { error: updErr } = await db
    .from('markets_review_queue')
    .update({
      payload: next as unknown as Record<string, unknown>,
      commodity: next.commodity,
      source: next.source,
    })
    .eq('id', id)
  if (updErr) throw new Error(`[markets] review entry update failed: ${updErr.message}`)

  await audit({
    actorId,
    action: 'update',
    targetTable: 'markets_review_queue',
    rowId: id,
    oldValue: prev as unknown as Record<string, unknown>,
    newValue: next as unknown as Record<string, unknown>,
    note: 'review-queue entry edited',
  }, client)

  return next
}

// ── Promote (approve) ────────────────────────────────────────────────────────

export interface ApproveResult {
  id: string
  ok: boolean
  observationId?: string
  supersededId?: string | null
  error?: string
}

/**
 * Promote a single pending entry to a live observation:
 *   1. validate (reject null commodity / geo / measure / season / value);
 *   2. mark any existing current figure for the same key SUPERSEDED;
 *   3. insert the new live observation;
 *   4. flip the queue row to 'approved';
 *   5. audit-log the supersede + insert + approval.
 * Returns a per-entry result; never throws for a single bad entry (so a bulk
 * run can report partial success).
 */
export async function approveEntry(
  id: string,
  actorId: string | null,
  client?: ReviewQueueDbClient,
): Promise<ApproveResult> {
  const db = resolveClient(client)
  try {
    const { data: rows, error: readErr } = await db
      .from('markets_review_queue')
      .select('*')
      .eq('id', id)
    if (readErr) throw new Error(readErr.message)
    const entry = (rows ?? [])[0] as unknown as ReviewQueueEntry | undefined
    if (!entry) return { id, ok: false, error: 'Entry not found.' }
    if (entry.status !== 'pending') return { id, ok: false, error: `Entry is already ${entry.status}.` }

    const payload = parsePending(entry.payload ?? {})
    const validation = validateObservation(payload)
    if (!validation.ok) return { id, ok: false, error: validation.errors.join(' ') }

    // Non-null after validation.
    const geo = payload.geo as string
    const commodity = payload.commodity as string
    const measure = payload.measure as string
    const season = payload.season as string
    const value = payload.value as number

    // 1. Supersede any current figure for the same key.
    let supersededId: string | null = null
    const { data: liveRows, error: liveErr } = await db
      .from('markets_observations')
      .select('id, geo, commodity, measure, season, value, unit, source, confidence')
      .eq('commodity', commodity)
      .eq('geo', geo)
      .eq('measure', measure)
      .eq('season', season)
      .is('archived_at', null)
      .is('superseded_at', null)
    if (liveErr) throw new Error(liveErr.message)
    const prior = (liveRows ?? [])[0] as unknown as LiveObservation | undefined
    if (prior) {
      const { error: supErr } = await db
        .from('markets_observations')
        .update({ superseded_at: new Date().toISOString(), superseded_by: id })
        .eq('id', prior.id)
      if (supErr) throw new Error(supErr.message)
      supersededId = prior.id
      await audit({
        actorId,
        action: 'archive',
        targetTable: 'markets_observations',
        rowId: prior.id,
        oldValue: prior as unknown as Record<string, unknown>,
        note: `superseded by approved review entry ${id}`,
      }, client)
    }

    // 2. Insert the new live observation.
    const insertRow = {
      geo,
      commodity,
      measure,
      season,
      value,
      source: payload.source,
      confidence: payload.confidence,
      note: payload.note,
    }
    const { data: inserted, error: insErr } = await db
      .from('markets_observations')
      .insert(insertRow)
      .select('id')
      .single()
    if (insErr) throw new Error(insErr.message)
    const observationId = (inserted as { id: string }).id

    await audit({
      actorId,
      action: 'insert',
      targetTable: 'markets_observations',
      rowId: observationId,
      newValue: insertRow as unknown as Record<string, unknown>,
      note: `promoted from review entry ${id}`,
    }, client)

    // 3. Flip the queue row to approved.
    const { error: flipErr } = await db
      .from('markets_review_queue')
      .update({
        status: 'approved',
        reviewed_by: actorId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)
    if (flipErr) throw new Error(flipErr.message)

    await audit({
      actorId,
      action: 'update',
      targetTable: 'markets_review_queue',
      rowId: id,
      newValue: { status: 'approved', observation_id: observationId },
      note: 'review entry approved → observation promoted',
    }, client)

    return { id, ok: true, observationId, supersededId }
  } catch (err) {
    return { id, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Approve many entries in sequence, returning a per-entry result. */
export async function approveEntries(
  ids: string[],
  actorId: string | null,
  client?: ReviewQueueDbClient,
): Promise<ApproveResult[]> {
  const results: ApproveResult[] = []
  for (const id of ids) {
    results.push(await approveEntry(id, actorId, client))
  }
  return results
}

// ── Reject / defer ────────────────────────────────────────────────────────────

/** Reject a pending entry with an optional reason. */
export async function rejectEntry(
  id: string,
  reason: string | null,
  actorId: string | null,
  client?: ReviewQueueDbClient,
): Promise<ReviewQueueEntry> {
  const db = resolveClient(client)
  const { error } = await db
    .from('markets_review_queue')
    .update({
      status: 'rejected',
      reviewed_by: actorId,
      review_note: reason,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id)
  if (error) throw new Error(`[markets] review entry reject failed: ${error.message}`)

  await audit({
    actorId,
    action: 'update',
    targetTable: 'markets_review_queue',
    rowId: id,
    newValue: { status: 'rejected', review_note: reason },
    note: 'review entry rejected',
  }, client)
  return { id } as ReviewQueueEntry
}

/**
 * Defer an entry: keep it 'pending' but record a note (and the reviewer who
 * parked it) so it can be revisited. Optional per the brief.
 */
export async function deferEntry(
  id: string,
  note: string | null,
  actorId: string | null,
  client?: ReviewQueueDbClient,
): Promise<ReviewQueueEntry> {
  const db = resolveClient(client)
  const { error } = await db
    .from('markets_review_queue')
    .update({ status: 'pending', review_note: note, reviewed_by: actorId })
    .eq('id', id)
  if (error) throw new Error(`[markets] review entry defer failed: ${error.message}`)
  await audit({
    actorId,
    action: 'update',
    targetTable: 'markets_review_queue',
    rowId: id,
    newValue: { status: 'pending', review_note: note, deferred: true },
    note: 'review entry deferred',
  }, client)
  return { id } as ReviewQueueEntry
}
