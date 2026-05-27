import { NextResponse }     from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { encrypt }           from '@/lib/encryption'

export const runtime = 'nodejs'

async function verifyAdminAccess(agentId: string, activeGroupId: string, userId: string) {
  const supabase = createClient()
  const { data: agent } = await supabase
    .from('agents')
    .select('id')
    .eq('id', agentId)
    .eq('group_id', activeGroupId)
    .single()
  if (!agent) return false

  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', userId)
    .eq('group_id', activeGroupId)
    .single()

  return membership?.role === 'super_admin' || membership?.role === 'group_owner' || membership?.role === 'group_admin'
}

// ── PATCH /api/agents/[id]/credentials/[credId] ───────────────────────────────

export async function PATCH(
  request: Request,
  { params }: { params: { id: string; credId: string } }
) {
  const supabase   = createClient()
  const cookieStore = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const ok = await verifyAdminAccess(params.id, activeGroupId, session.user.id)
  if (!ok) return NextResponse.json({ error: 'Agent not found or insufficient permissions' }, { status: 404 })

  let body: Record<string, unknown>
  try { body = await request.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if ('name'        in body) updates.name        = (body.name as string).trim()
  if ('description' in body) updates.description = typeof body.description === 'string' ? body.description.trim() || null : null
  if ('is_active'   in body) updates.is_active   = !!body.is_active
  if ('expires_at'  in body) updates.expires_at  = body.expires_at ?? null

  if ('value' in body && typeof body.value === 'string') {
    try {
      updates.value = encrypt(body.value)
    } catch (err) {
      return NextResponse.json({ error: `Encryption failed: ${err instanceof Error ? err.message : 'Unknown'}` }, { status: 500 })
    }
  }

  const admin = createAdminClient()
  const { data: cred, error } = await admin
    .from('agent_credentials')
    .update(updates)
    .eq('id', params.credId)
    .eq('agent_id', params.id)
    .select('id, agent_id, name, key, description, last_used_at, expires_at, is_active, created_at')
    .single()

  if (error || !cred) return NextResponse.json({ error: 'Credential not found' }, { status: 404 })

  return NextResponse.json({ data: cred })
}

// ── DELETE /api/agents/[id]/credentials/[credId] ──────────────────────────────
// Hard delete — credentials are explicitly removable

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string; credId: string } }
) {
  const supabase   = createClient()
  const cookieStore = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const ok = await verifyAdminAccess(params.id, activeGroupId, session.user.id)
  if (!ok) return NextResponse.json({ error: 'Agent not found or insufficient permissions' }, { status: 404 })

  const admin = createAdminClient()
  const { error } = await admin
    .from('agent_credentials')
    .delete()
    .eq('id', params.credId)
    .eq('agent_id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data: { id: params.credId, deleted: true } })
}
