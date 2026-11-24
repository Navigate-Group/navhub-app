import { NextResponse } from 'next/server'
import { getTrackerContext } from '@/lib/tracker/server'
import { writeErrorResponse, intInRange } from '@/lib/tracker/api'

// The choices the settings form offers. The database is the real guard (only
// Managers / Group Owners may update, migration 082); these lists just keep
// the stored values sensible.
const REVIEW_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const WEEK_STARTS = ['monday', 'sunday']
const TIME_ZONES = [
  'Australia/Perth',
  'Australia/Darwin',
  'Australia/Adelaide',
  'Australia/Brisbane',
  'Australia/Sydney',
  'Australia/Melbourne',
  'Australia/Hobart',
]

// PATCH /api/tracker/settings — update the group's tracker thresholds and
// calendar settings. Runs as the signed-in user via the server client, so RLS
// (migration 082: editors only) decides. Changes take effect immediately.
export async function PATCH(request: Request) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase, groupId } = ctx

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const chaser = intInRange(body.chaser_days, 1, 365)
  const stale = intInRange(body.stale_days, 1, 365)
  const contact = intInRange(body.contact_followup_days, 1, 365)
  if (chaser === null || stale === null || contact === null) {
    return NextResponse.json(
      { error: 'Each reminder must be a whole number of days between 1 and 365' },
      { status: 422 },
    )
  }

  const reviewDay = typeof body.review_day === 'string' ? body.review_day : ''
  const weekStart = typeof body.week_start === 'string' ? body.week_start : ''
  const timeZone = typeof body.time_zone === 'string' ? body.time_zone : ''
  if (!REVIEW_DAYS.includes(reviewDay)) {
    return NextResponse.json({ error: 'Pick a review day' }, { status: 422 })
  }
  if (!WEEK_STARTS.includes(weekStart)) {
    return NextResponse.json({ error: 'The week can start on Monday or Sunday' }, { status: 422 })
  }
  if (!TIME_ZONES.includes(timeZone)) {
    return NextResponse.json({ error: 'Pick a time zone' }, { status: 422 })
  }

  const { error } = await supabase
    .from('tracker_settings')
    .update({
      chaser_days: chaser,
      stale_days: stale,
      contact_followup_days: contact,
      review_day: reviewDay,
      week_start: weekStart,
      time_zone: timeZone,
    })
    .eq('group_id', groupId)

  if (error) return writeErrorResponse(error)

  return NextResponse.json({ ok: true })
}
