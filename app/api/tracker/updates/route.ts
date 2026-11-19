import { NextResponse } from 'next/server'
import { getTrackerContext } from '@/lib/tracker/server'
import { writeErrorResponse, strOrNull } from '@/lib/tracker/api'

// POST /api/tracker/updates — log an update against a plan.
// Body: { plan_id, date?, source?, text }
// RLS requires edit access to the plan (082). After the insert, migration
// 079's trigger moves the plan's "Last updated" forward. author_id is stamped
// by the DB from auth.uid().
export async function POST(request: Request) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase, groupId } = ctx

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const planId = strOrNull(body.plan_id)
  const text = strOrNull(body.text)
  if (!planId) return NextResponse.json({ error: 'plan_id is required' }, { status: 422 })
  if (!text) return NextResponse.json({ error: 'An update needs some text' }, { status: 422 })

  const insert: Record<string, unknown> = {
    group_id: groupId,
    plan_id: planId,
    text,
    source: strOrNull(body.source),
  }
  const date = strOrNull(body.date)
  if (date) insert.date = date // else the DB default (today, group tz) applies

  const { data, error } = await supabase
    .from('tracker_updates')
    .insert(insert)
    .select('id')
    .single()

  if (error) return writeErrorResponse(error)
  return NextResponse.json({ data }, { status: 201 })
}
