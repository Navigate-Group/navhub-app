import { NextResponse } from 'next/server'
import { getTrackerContext } from '@/lib/tracker/server'
import { writeErrorResponse, strOrNull } from '@/lib/tracker/api'

// POST /api/tracker/shares — give or change a person's project access.
// Body: { plan_id, user_id, level: 'comment' | 'edit' }
// RLS (082) restricts writes to Managers / Group Owners of the plan's group;
// the share guard checks the person is a non-editor member of the group and
// stamps shared_by. Upserts on (plan_id, user_id) so re-giving changes the level.
export async function POST(request: Request) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase } = ctx

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const planId = strOrNull(body.plan_id)
  const userId = strOrNull(body.user_id)
  const level = strOrNull(body.level)
  if (!planId) return NextResponse.json({ error: 'plan_id is required' }, { status: 422 })
  if (!userId) return NextResponse.json({ error: 'A person is required' }, { status: 422 })
  if (level !== 'comment' && level !== 'edit') {
    return NextResponse.json({ error: 'Access is Comment or Edit' }, { status: 422 })
  }

  const { data, error } = await supabase
    .from('tracker_plan_shares')
    .upsert({ plan_id: planId, user_id: userId, level }, { onConflict: 'plan_id,user_id' })
    .select('id')

  if (error) return writeErrorResponse(error)
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "You don't have permission to give access to this project" },
      { status: 403 },
    )
  }
  return NextResponse.json({ data: data[0] }, { status: 201 })
}

// DELETE /api/tracker/shares — remove a person's project access.
// Body: { plan_id, user_id }
export async function DELETE(request: Request) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase } = ctx

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const planId = strOrNull(body.plan_id)
  const userId = strOrNull(body.user_id)
  if (!planId) return NextResponse.json({ error: 'plan_id is required' }, { status: 422 })
  if (!userId) return NextResponse.json({ error: 'A person is required' }, { status: 422 })

  const { data, error } = await supabase
    .from('tracker_plan_shares')
    .delete()
    .eq('plan_id', planId)
    .eq('user_id', userId)
    .select('id')

  if (error) return writeErrorResponse(error)
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "You don't have permission to change access to this project" },
      { status: 403 },
    )
  }
  return NextResponse.json({ ok: true })
}
