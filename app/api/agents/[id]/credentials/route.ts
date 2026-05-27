import { NextResponse }     from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { encrypt }           from '@/lib/encryption'

export const runtime = 'nodejs'

async function verifyAdminAccess(agentId: string, activeGroupId: string, userId: string) {
  const supabase = createClient()

  // Check agent belongs to group (RLS)
  const { data: agent } = await supabase
    .from('agents')
    .select('id, group_id')
    .eq('id', agentId)
    .eq('group_id', activeGroupId)
    .single()
  if (!agent) return null

  // Check admin role
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', userId)
    .eq('group_id', activeGroupId)
    .single()

  const isAdmin = membership?.role === 'super_admin' || membership?.role === 'group_owner' || membership?.role === 'group_admin'
  return isAdmin ? agent : null
}

// ── GET /api/agents/[id]/credentials ─────────────────────────────────────────
// Returns metadata only — credential values are never returned

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase   = createClient()
  const cookieStore = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const agent = await verifyAdminAccess(params.id, activeGroupId, session.user.id)
  if (!agent) return NextResponse.json({ error: 'Agent not found or insufficient permissions' }, { status: 404 })

  const admin = createAdminClient()
  const { data: creds, error } = await admin
    .from('agent_credentials')
    .select('id, agent_id, name, key, description, last_used_at, expires_at, is_active, created_at')
    .eq('agent_id', params.id)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data: creds ?? [] })
}

// ── POST /api/agents/[id]/credentials ────────────────────────────────────────
// Add a new encrypted credential

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase   = createClient()
  const cookieStore = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const agent = await verifyAdminAccess(params.id, activeGroupId, session.user.id)
  if (!agent) return NextResponse.json({ error: 'Agent not found or insufficient permissions' }, { status: 404 })

  let body: Record<string, unknown>
  try { body = await request.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { name, key, value } = body
  if (!name || !key || !value) {
    return NextResponse.json({ error: 'name, key and value are required' }, { status: 422 })
  }

  let encryptedValue: string
  try {
    encryptedValue = encrypt(value as string)
  } catch (err) {
    return NextResponse.json({ error: `Encryption failed: ${err instanceof Error ? err.message : 'Unknown'}` }, { status: 500 })
  }

  const admin = createAdminClient()
  const { data: cred, error } = await admin
    .from('agent_credentials')
    .insert({
      agent_id:    params.id,
      group_id:    activeGroupId,
      name:        (name as string).trim(),
      key:         (key as string).trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
      value:       encryptedValue,
      description: typeof body.description === 'string' ? body.description.trim() || null : null,
      expires_at:  typeof body.expires_at === 'string' ? body.expires_at : null,
      created_by:  session.user.id,
    })
    .select('id, agent_id, name, key, description, last_used_at, expires_at, is_active, created_at')
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: `Credential with key "${key}" already exists` }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data: cred }, { status: 201 })
}
