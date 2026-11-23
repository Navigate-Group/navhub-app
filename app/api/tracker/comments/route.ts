import { NextResponse } from 'next/server'
import { getTrackerContext } from '@/lib/tracker/server'
import { writeErrorResponse, strOrNull } from '@/lib/tracker/api'

// POST /api/tracker/comments — post a project comment.
// Body: { plan_id, body }
// RLS (082) requires comment (or edit) access on the plan; the comment guard
// stamps author_id = auth.uid(). Project comments only (entity_type 'plan',
// entity_id = plan_id).
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

  const planId = strOrNull(body.plan_id)
  const text = strOrNull(body.body)
  if (!planId) return NextResponse.json({ error: 'plan_id is required' }, { status: 422 })
  if (!text) return NextResponse.json({ error: 'A comment needs some text' }, { status: 422 })

  const { data, error } = await supabase
    .from('tracker_comments')
    .insert({
      group_id: groupId,
      plan_id: planId,
      entity_type: 'plan',
      entity_id: planId,
      author_id: userId,
      body: text,
    })
    .select('id')
    .single()

  if (error) return writeErrorResponse(error)
  return NextResponse.json({ data }, { status: 201 })
}
