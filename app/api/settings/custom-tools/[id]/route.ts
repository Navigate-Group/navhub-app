import { NextResponse } from 'next/server'
import { cookies }       from 'next/headers'
import { createClient }  from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

async function verifyAdminAccess(supabase: ReturnType<typeof createClient>, userId: string, groupId: string) {
  const { data } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', userId)
    .eq('group_id', groupId)
    .single()
  return data && ['super_admin', 'group_owner', 'group_admin'].includes(data.role)
}

// ─── PATCH — update a custom tool ──────────────────────────────────────────

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  if (!(await verifyAdminAccess(supabase, session.user.id, activeGroupId))) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const admin = createAdminClient()
  const { data: existing } = await admin
    .from('custom_tools')
    .select('id')
    .eq('id', params.id)
    .eq('group_id', activeGroupId)
    .single()
  if (!existing) return NextResponse.json({ error: 'Tool not found' }, { status: 404 })

  let body: Record<string, unknown>
  try { body = await request.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  const textFields = ['label', 'description', 'webhook_url', 'http_method'] as const
  for (const f of textFields) {
    if (f in body && typeof body[f] === 'string') updates[f] = (body[f] as string).trim()
  }
  if ('headers'    in body) updates.headers    = body.headers    ?? {}
  if ('parameters' in body) updates.parameters = body.parameters ?? []
  if ('is_active'  in body) updates.is_active  = !!body.is_active

  const { data, error } = await admin
    .from('custom_tools')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data })
}

// ─── DELETE — hard-delete a custom tool ────────────────────────────────────

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  if (!(await verifyAdminAccess(supabase, session.user.id, activeGroupId))) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const admin = createAdminClient()
  await admin
    .from('custom_tools')
    .delete()
    .eq('id', params.id)
    .eq('group_id', activeGroupId)

  return NextResponse.json({ data: { deleted: true } })
}
