import { NextResponse } from 'next/server'
import { cookies }       from 'next/headers'
import { createClient }  from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// ─── GET — list all tool overrides for this agent ──────────────────────────

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('agent_tool_overrides')
    .select('id, agent_id, tool_name, enabled, created_at')
    .eq('agent_id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data: data ?? [] })
}

// ─── PUT — upsert an override for a specific tool ──────────────────────────
// Body: { tool_name: string, enabled: boolean }

export async function PUT(
  request: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId)
    .single()
  if (!membership || !['super_admin', 'group_owner', 'group_admin'].includes(membership.role)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  let body: { tool_name?: string; enabled?: boolean }
  try { body = await request.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  if (!body.tool_name || typeof body.tool_name !== 'string') {
    return NextResponse.json({ error: 'tool_name is required' }, { status: 422 })
  }
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be boolean' }, { status: 422 })
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('agent_tool_overrides')
    .upsert({
      agent_id:  params.id,
      tool_name: body.tool_name,
      enabled:   body.enabled,
    }, { onConflict: 'agent_id,tool_name' })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data })
}
