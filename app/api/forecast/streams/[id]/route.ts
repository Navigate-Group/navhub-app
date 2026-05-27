import { NextResponse } from 'next/server'
import { cookies }      from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { ForecastStream } from '@/lib/types'

// ─── PATCH /api/forecast/streams/[id] ────────────────────────────────────────
// Updates any subset of stream fields.
// Validates user has admin role in the stream's group.
//
// ─── DELETE /api/forecast/streams/[id] ───────────────────────────────────────
// Soft-deletes a stream (sets is_active = false).

const ADMIN_ROLES = ['super_admin', 'group_owner', 'group_admin']

async function getContext(id: string) {
  const supabase    = createClient()
  const cookieStore = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return { error: 'Unauthorised', status: 401 } as const

  // Load stream to verify ownership (RLS enforces group membership read)
  const { data: stream } = await supabase
    .from('forecast_streams')
    .select('group_id')
    .eq('id', id)
    .single()

  if (!stream) return { error: 'Stream not found', status: 404 } as const

  // Verify admin role in the stream's group (must match active group too)
  if (stream.group_id !== activeGroupId) {
    return { error: 'Stream not found', status: 404 } as const
  }

  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', stream.group_id)
    .single()

  if (!membership || !ADMIN_ROLES.includes(membership.role)) {
    return { error: 'Admin access required', status: 403 } as const
  }

  return { supabase, session, groupId: stream.group_id, ok: true } as const
}

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const ctx = await getContext(params.id)
  if ('error' in ctx) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status })
  }

  let body: Record<string, unknown>
  try { body = await request.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  // Only allow updating specific fields
  const allowed = ['name', 'tag', 'color', 'y1_baseline', 'default_growth_rate', 'default_gp_margin', 'sort_order']
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  allowed.forEach(key => {
    if (key in body) updates[key] = body[key]
  })

  const admin = createAdminClient()
  const { data: stream, error } = await admin
    .from('forecast_streams')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data: stream as ForecastStream })
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const ctx = await getContext(params.id)
  if ('error' in ctx) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status })
  }

  const admin = createAdminClient()
  const { error } = await admin
    .from('forecast_streams')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', params.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data: { id: params.id } })
}
