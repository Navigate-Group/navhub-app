import { NextResponse } from 'next/server'
import { getTrackerContext } from '@/lib/tracker/server'
import { writeErrorResponse, strOrNull } from '@/lib/tracker/api'

// POST /api/tracker/actions — add an action to a plan.
// Body: { plan_id, title, type?, who?, assignee_id?, due_on?, status?,
//         priority?, milestone_id?, notes? }
// RLS requires edit access to the plan, or editor for a plan-less action (082).
// done_on / waiting_since follow the status via migration 085's trigger.
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
  if (!title) return NextResponse.json({ error: 'An action title is required' }, { status: 422 })

  const status = strOrNull(body.status)
  const insert: Record<string, unknown> = {
    group_id: groupId,
    plan_id: planId,
    title,
    type: strOrNull(body.type),
    who: strOrNull(body.who),
    assignee_id: strOrNull(body.assignee_id),
    due_on: strOrNull(body.due_on),
    status: status === 'waiting' || status === 'done' ? status : 'open',
    priority: strOrNull(body.priority) ?? 'normal',
    milestone_id: strOrNull(body.milestone_id),
    notes: strOrNull(body.notes),
  }

  const { data, error } = await supabase
    .from('tracker_actions')
    .insert(insert)
    .select('id')
    .single()

  if (error) return writeErrorResponse(error)
  return NextResponse.json({ data }, { status: 201 })
}
