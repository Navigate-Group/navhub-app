import { NextResponse } from 'next/server'
import { getTrackerContext } from '@/lib/tracker/server'
import { writeErrorResponse, strOrNull, intInRange } from '@/lib/tracker/api'

// POST /api/tracker/milestones — add a milestone to a plan.
// Body: { plan_id, title, description?, owner_id?, status?, health?, start_on?,
//         due_on?, priority?, progress_mode?, progress_pct? }
// RLS requires edit access to the plan (082). baseline_due_on defaults to due_on
// and completed_on follows the status via migration 085's trigger. created_by is
// stamped by the DB from auth.uid().
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
  const title = strOrNull(body.title)
  if (!planId) return NextResponse.json({ error: 'plan_id is required' }, { status: 422 })
  if (!title) return NextResponse.json({ error: 'A milestone title is required' }, { status: 422 })

  const insert: Record<string, unknown> = {
    group_id: groupId,
    plan_id: planId,
    title,
    description: strOrNull(body.description),
    owner_id: strOrNull(body.owner_id),
    status: strOrNull(body.status) ?? 'backlog',
    health: strOrNull(body.health) ?? 'on_track',
    priority: strOrNull(body.priority) ?? 'normal',
    start_on: strOrNull(body.start_on),
    due_on: strOrNull(body.due_on),
    progress_mode: strOrNull(body.progress_mode) === 'from_actions' ? 'from_actions' : 'manual',
    progress_pct: intInRange(body.progress_pct, 0, 100) ?? 0,
  }

  const { data, error } = await supabase
    .from('tracker_milestones')
    .insert(insert)
    .select('id')
    .single()

  if (error) return writeErrorResponse(error)
  return NextResponse.json({ data }, { status: 201 })
}
