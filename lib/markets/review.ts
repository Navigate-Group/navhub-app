/**
 * Markets review-queue helpers (MKT-6) — server-side only.
 * ──────────────────────────────────────────────────────────────────────────
 * Stages observations proposed by the template-import pipeline (MKT-6d) in the
 * `markets_review_queue` table (migration 075) so a Manager can approve or
 * reject each one before it is promoted into markets_observations.
 *
 * Provides:
 *   • queueObservation   — stage a proposed observation (status 'pending')
 *   • fetchPendingReviews — list pending rows (newest first), optionally by commodity
 *   • updateReviewStatus — record a Manager's approve / reject decision
 *
 * ⚠️  Import only in server-side code. Writes use the service-role admin client
 *     by default; route-level role gating authorises the caller. A client may
 *     be injected (e.g. in tests, or to reuse a request-scoped client).
 */

import { createAdminClient } from '../supabase/admin'

/** The lifecycle status of a queued observation. */
export type ReviewStatus = 'pending' | 'approved' | 'rejected'

/** A review-queue row, mirroring the markets_review_queue table columns. */
export interface ReviewQueueEntry {
  id: string
  payload: Record<string, unknown>
  commodity: string | null
  source: string | null
  status: ReviewStatus
  submitted_by: string | null
  reviewed_by: string | null
  review_note: string | null
  created_at: string
  reviewed_at: string | null
}

/** The inputs needed to queue an observation for review. */
export interface QueueObservationInput {
  /** The full proposed markets_observations row shape, as an object. */
  payload: Record<string, unknown>
  /** The submitting user's id, or null for a system / service import. */
  submittedBy: string | null
  /** Denormalised commodity id for queue filtering (defaults from payload.commodity). */
  commodity?: string | null
  /** Denormalised source id for display (defaults from payload.source). */
  source?: string | null
}

/**
 * The minimal Supabase surface the review helpers use. Narrowing to this shape
 * (rather than importing the full SupabaseClient type) keeps the helpers
 * trivially mockable in unit tests without a live database. The query-builder
 * methods are chainable and thenable, mirroring supabase-js.
 */
export interface ReviewQueryResult<T> {
  data: T | null
  error: { message: string } | null
}

export interface ReviewSelectBuilder<T> extends PromiseLike<ReviewQueryResult<T[]>> {
  eq(column: string, value: unknown): ReviewSelectBuilder<T>
  order(column: string, opts: { ascending: boolean }): ReviewSelectBuilder<T>
}

export interface ReviewDbClient {
  from(table: string): {
    insert(values: Record<string, unknown>): {
      select(columns?: string): {
        single(): Promise<ReviewQueryResult<ReviewQueueEntry>>
      }
    }
    select(columns?: string): ReviewSelectBuilder<ReviewQueueEntry>
    update(values: Record<string, unknown>): {
      eq(column: string, value: unknown): {
        select(columns?: string): {
          single(): Promise<ReviewQueryResult<ReviewQueueEntry>>
        }
      }
    }
  }
}

function resolveClient(client?: ReviewDbClient): ReviewDbClient {
  return client ?? (createAdminClient() as unknown as ReviewDbClient)
}

/**
 * Stage a proposed observation in the review queue with status 'pending'.
 * Returns the inserted row. Throws if the insert fails.
 */
export async function queueObservation(
  input: QueueObservationInput,
  client?: ReviewDbClient,
): Promise<ReviewQueueEntry> {
  const db = resolveClient(client)

  const payloadCommodity =
    typeof input.payload.commodity === 'string' ? input.payload.commodity : null
  const payloadSource =
    typeof input.payload.source === 'string' ? input.payload.source : null

  const row = {
    payload: input.payload,
    commodity: input.commodity ?? payloadCommodity,
    source: input.source ?? payloadSource,
    status: 'pending' as const,
    submitted_by: input.submittedBy,
  }

  const { data, error } = await db
    .from('markets_review_queue')
    .insert(row)
    .select()
    .single()
  if (error) {
    throw new Error(`[markets] review-queue insert failed: ${error.message}`)
  }
  return data as ReviewQueueEntry
}

/**
 * Fetch pending review-queue rows, newest first. Pass a commodity id to scope
 * the list to a single commodity. Throws if the query fails.
 */
export async function fetchPendingReviews(
  commodity?: string,
  client?: ReviewDbClient,
): Promise<ReviewQueueEntry[]> {
  const db = resolveClient(client)

  let query = db
    .from('markets_review_queue')
    .select()
    .eq('status', 'pending')
  if (commodity) {
    query = query.eq('commodity', commodity)
  }
  query = query.order('created_at', { ascending: false })

  const { data, error } = await query
  if (error) {
    throw new Error(`[markets] review-queue fetch failed: ${error.message}`)
  }
  return (data ?? []) as ReviewQueueEntry[]
}

/** The inputs needed to record a review decision. */
export interface UpdateReviewStatusInput {
  id: string
  status: Extract<ReviewStatus, 'approved' | 'rejected'>
  /** The reviewing Manager's id. */
  reviewedBy: string | null
  reviewNote?: string | null
}

/**
 * Record a Manager's approve / reject decision on a queued observation. Sets
 * the status, reviewer, note and reviewed_at timestamp. Returns the updated
 * row. Throws if the update fails.
 */
export async function updateReviewStatus(
  input: UpdateReviewStatusInput,
  client?: ReviewDbClient,
): Promise<ReviewQueueEntry> {
  const db = resolveClient(client)

  const patch = {
    status: input.status,
    reviewed_by: input.reviewedBy,
    review_note: input.reviewNote ?? null,
    reviewed_at: new Date().toISOString(),
  }

  const { data, error } = await db
    .from('markets_review_queue')
    .update(patch)
    .eq('id', input.id)
    .select()
    .single()
  if (error) {
    throw new Error(`[markets] review-queue update failed: ${error.message}`)
  }
  return data as ReviewQueueEntry
}
