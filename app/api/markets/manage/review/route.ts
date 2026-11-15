import { NextResponse } from 'next/server'
import { requireManager, readJson, str, num } from '../_auth'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  listReviewQueue,
  updateReviewEntry,
  approveEntries,
  rejectEntry,
  deferEntry,
  DEFAULT_PAGE_SIZE,
  type ReviewStatus,
  type EnrichedEntry,
} from '@/lib/markets/review-queue'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Markets Review Queue API (MKT-7b). Manager+ only — middleware hard-403s
 * non-managers on /api/markets/manage/*; requireManager() re-checks and supplies
 * the acting user id for the audit log.
 *
 *   GET  ?status=&search=&page=&pageSize=
 *        → paginated, status-filtered, searchable queue with per-status counts
 *          and each entry enriched with its live comparison + submitter email.
 *   PATCH { id, ...editableFields }            → edit a pending entry
 *   POST  { action: 'approve', ids: [] }       → promote one or many (bulk)
 *   POST  { action: 'reject',  id, reason }    → reject with optional reason
 *   POST  { action: 'defer',   id, note }      → park back to pending with a note
 */

const STATUSES = new Set<ReviewStatus | 'all'>(['all', 'pending', 'approved', 'rejected'])

export async function GET(req: Request) {
  const ctx = await requireManager()
  if (ctx.error) return ctx.error

  const sp = new URL(req.url).searchParams
  const statusRaw = sp.get('status') ?? 'pending'
  const status = STATUSES.has(statusRaw as ReviewStatus | 'all')
    ? (statusRaw as ReviewStatus | 'all')
    : 'pending'
  const search = sp.get('search') ?? undefined
  const page = Number(sp.get('page')) || 1
  const pageSize = Number(sp.get('pageSize')) || DEFAULT_PAGE_SIZE

  try {
    const result = await listReviewQueue({ status, search, page, pageSize })
    const enriched = await attachSubmitterEmails(result.entries)
    return NextResponse.json({ ...result, entries: enriched })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

/**
 * Resolve submitter_email for the page's entries via the auth-admin API. Kept in
 * the route (not the library) because it needs the service-role auth client; a
 * single listUsers call is cheap and mirrors the admin markets route.
 */
async function attachSubmitterEmails(entries: EnrichedEntry[]): Promise<EnrichedEntry[]> {
  const ids = new Set(entries.map(e => e.submitted_by).filter((i): i is string => !!i))
  if (ids.size === 0) return entries
  try {
    const admin = createAdminClient()
    const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
    const emailById = new Map((data?.users ?? []).map(u => [u.id, u.email ?? null]))
    return entries.map(e => ({
      ...e,
      submitter_email: e.submitted_by ? emailById.get(e.submitted_by) ?? null : null,
    }))
  } catch {
    return entries // best-effort; email is non-essential
  }
}

export async function PATCH(req: Request) {
  const ctx = await requireManager()
  if (ctx.error) return ctx.error
  const body = await readJson(req)
  const id = str(body.id)
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  try {
    const payload = await updateReviewEntry(
      id,
      {
        value: 'value' in body ? num(body.value) : undefined,
        unit: 'unit' in body ? str(body.unit) : undefined,
        commodity: 'commodity' in body ? str(body.commodity) : undefined,
        geo: 'geo' in body ? str(body.geo) : undefined,
        measure: 'measure' in body ? str(body.measure) : undefined,
        season: 'season' in body ? str(body.season) : undefined,
        source: 'source' in body ? str(body.source) : undefined,
        note: 'note' in body ? str(body.note) : undefined,
        commodity_label: 'commodity_label' in body ? str(body.commodity_label) : undefined,
        geo_label: 'geo_label' in body ? str(body.geo_label) : undefined,
      },
      ctx.userId,
    )
    return NextResponse.json({ payload })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}

export async function POST(req: Request) {
  const ctx = await requireManager()
  if (ctx.error) return ctx.error
  const body = await readJson(req)
  const action = str(body.action)

  try {
    if (action === 'approve') {
      const ids = Array.isArray(body.ids)
        ? body.ids.filter((x: unknown): x is string => typeof x === 'string')
        : []
      if (ids.length === 0) {
        return NextResponse.json({ error: 'ids[] is required for approve' }, { status: 400 })
      }
      const results = await approveEntries(ids, ctx.userId)
      const approved = results.filter(r => r.ok).length
      return NextResponse.json({
        results,
        approved,
        failed: results.length - approved,
      })
    }

    if (action === 'reject') {
      const id = str(body.id)
      if (!id) return NextResponse.json({ error: 'id is required for reject' }, { status: 400 })
      await rejectEntry(id, str(body.reason), ctx.userId)
      return NextResponse.json({ ok: true })
    }

    if (action === 'defer') {
      const id = str(body.id)
      if (!id) return NextResponse.json({ error: 'id is required for defer' }, { status: 400 })
      await deferEntry(id, str(body.note), ctx.userId)
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
