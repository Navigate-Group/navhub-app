import { NextResponse } from 'next/server'
import { getTrackerContext } from '@/lib/tracker/server'
import { writeErrorResponse } from '@/lib/tracker/api'

// PUT /api/tracker/reviews — save (upsert) the signed-in user's weekly review
// for one ISO week. Body: { iso_week, checks?, top3?, notes? }.
//
// One row per person per week, keyed on (group_id, user_id, iso_week). The
// database is the guard: tracker_reviews RLS (082) only lets a person see and
// write their own rows, so another person can never read or change this. The
// user_id is stamped from auth.uid() by the row's default / policy — we send it
// from the session so the upsert matches the primary key, but RLS still refuses
// any row whose user_id isn't the caller's.
const ISO_WEEK = /^[0-9]{4}-W[0-9]{2}$/

type Body = {
  iso_week?: unknown
  checks?: unknown
  top3?: unknown
  notes?: unknown
}

export async function PUT(request: Request) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase, groupId, userId } = ctx

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const isoWeek = typeof body.iso_week === 'string' ? body.iso_week.trim() : ''
  if (!ISO_WEEK.test(isoWeek)) {
    return NextResponse.json({ error: 'A valid iso_week (YYYY-Www) is required' }, { status: 422 })
  }

  // The upsert sends only the fields present in the body, so partial saves (just
  // the checklist, or just the notes) don't wipe the others. checks is a
  // string→boolean map; top3/notes are free text (null clears them).
  const row: Record<string, unknown> = {
    group_id: groupId,
    user_id: userId,
    iso_week: isoWeek,
  }

  if ('checks' in body) {
    const checks: Record<string, boolean> = {}
    if (body.checks && typeof body.checks === 'object' && !Array.isArray(body.checks)) {
      for (const [k, v] of Object.entries(body.checks as Record<string, unknown>)) {
        if (typeof v === 'boolean') checks[k] = v
      }
    }
    row.checks = checks
  }
  if ('top3' in body) {
    row.top3 = typeof body.top3 === 'string' && body.top3.trim() !== '' ? body.top3 : null
  }
  if ('notes' in body) {
    row.notes = typeof body.notes === 'string' && body.notes.trim() !== '' ? body.notes : null
  }

  const { error } = await supabase
    .from('tracker_reviews')
    .upsert(row, { onConflict: 'group_id,user_id,iso_week' })

  if (error) return writeErrorResponse(error)
  return NextResponse.json({ ok: true })
}
