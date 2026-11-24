import { NextResponse } from 'next/server'
import { getTrackerContext } from '@/lib/tracker/server'
import { writeErrorResponse, strOrNull } from '@/lib/tracker/api'

// POST /api/tracker/reviews — save the signed-in user's weekly review.
// Body: { iso_week, checks?, top3?, notes? }
// One row per person per week (PK group_id, user_id, iso_week). RLS (082,
// tracker_reviews_own) lets each person read and write only their own row, so
// nobody can save or see anyone else's review. We upsert so ticking a box,
// editing the top three or the notes all land on the same row.
//
// Only the fields present in the body are written, so a quick checkbox save
// never clobbers the notes and vice versa.
const ISO_WEEK_RE = /^[0-9]{4}-W[0-9]{2}$/

export async function POST(request: Request) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase, userId, groupId } = ctx

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const isoWeek = strOrNull(body.iso_week)
  if (!isoWeek || !ISO_WEEK_RE.test(isoWeek)) {
    return NextResponse.json({ error: 'A valid iso_week is required' }, { status: 422 })
  }

  // Build the row to write. group_id/user_id/iso_week identify it; the three
  // editable fields are only set when present in the body.
  const row: Record<string, unknown> = {
    group_id: groupId,
    user_id: userId,
    iso_week: isoWeek,
  }

  if ('checks' in body) {
    // checks is a map of step key → boolean. Keep only boolean-valued entries.
    const checks: Record<string, boolean> = {}
    if (body.checks && typeof body.checks === 'object' && !Array.isArray(body.checks)) {
      for (const [k, val] of Object.entries(body.checks as Record<string, unknown>)) {
        if (typeof val === 'boolean') checks[k] = val
      }
    }
    row.checks = checks
  }
  if ('top3' in body) row.top3 = strOrNull(body.top3)
  if ('notes' in body) row.notes = strOrNull(body.notes)
  // Bump the row's own updated_at on every save.
  row.updated_at = new Date().toISOString()

  const { error } = await supabase
    .from('tracker_reviews')
    .upsert(row, { onConflict: 'group_id,user_id,iso_week' })

  if (error) return writeErrorResponse(error)
  return NextResponse.json({ ok: true })
}
