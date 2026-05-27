import { NextResponse }     from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

// ── GET /api/agents/[id] ─────────────────────────────────────────────────────

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

  const { data: agent, error } = await supabase
    .from('agents')
    .select('*')
    .eq('id', params.id)
    .eq('group_id', activeGroupId)
    .single()

  if (error || !agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  return NextResponse.json({ data: agent })
}

// ── PATCH /api/agents/[id] ───────────────────────────────────────────────────

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase   = createClient()
  const cookieStore = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  // Verify admin + agent belongs to group (RLS read)
  const { data: existing } = await supabase
    .from('agents')
    .select('id')
    .eq('id', params.id)
    .eq('group_id', activeGroupId)
    .single()
  if (!existing) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId)
    .single()
  const isAdmin = membership?.role === 'super_admin' || membership?.role === 'group_owner' || membership?.role === 'group_admin'
  if (!isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  let body: Record<string, unknown>
  try { body = await request.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }

  // Trimmed text fields — empty string becomes null
  const textFields = [
    'name', 'description', 'avatar_color', 'avatar_preset', 'avatar_url',
    'model', 'model_provider', 'model_name', 'model_api_key', 'model_config_id',
    'ai_provider', 'ai_model',
    'persona_preset', 'persona', 'instructions',
    'email_address', 'email_display_name', 'slack_channel',
    'visibility', 'knowledge_text',
    'communication_style', 'response_length',
    'notify_email', 'notify_slack_channel',
  ] as const
  for (const f of textFields) {
    if (f in body) {
      const val = body[f]
      if (val === null)                       updates[f] = null
      else if (typeof val === 'string')       updates[f] = val.trim() || null
      else                                     updates[f] = null
    }
  }
  if ('name' in body && (!updates.name || (updates.name as string).length < 1)) {
    return NextResponse.json({ error: 'Name cannot be empty' }, { status: 422 })
  }
  if ('tools' in body)          updates.tools          = Array.isArray(body.tools) ? body.tools : []
  if ('company_scope' in body)  updates.company_scope  = Array.isArray(body.company_scope) && (body.company_scope as unknown[]).length > 0 ? body.company_scope : null
  if ('email_recipients' in body) updates.email_recipients = Array.isArray(body.email_recipients) && (body.email_recipients as unknown[]).length > 0 ? body.email_recipients : null
  if ('knowledge_links' in body) updates.knowledge_links = Array.isArray(body.knowledge_links) ? body.knowledge_links : []
  if ('is_active' in body)      updates.is_active      = !!body.is_active
  if ('schedule_enabled' in body) updates.schedule_enabled = !!body.schedule_enabled
  if ('notify_on_completion' in body) updates.notify_on_completion = !!body.notify_on_completion
  if ('notify_on_output' in body)     updates.notify_on_output     = !!body.notify_on_output
  if ('schedule_config' in body)  updates.schedule_config  = body.schedule_config ?? null
  if ('next_scheduled_run_at' in body) updates.next_scheduled_run_at = body.next_scheduled_run_at ?? null
  if ('last_scheduled_run_at' in body) updates.last_scheduled_run_at = body.last_scheduled_run_at ?? null

  const admin = createAdminClient()
  const { data: agent, error } = await admin
    .from('agents')
    .update(updates)
    .eq('id', params.id)
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data: agent })
}

// ── DELETE /api/agents/[id] ──────────────────────────────────────────────────
// Soft delete (is_active = false)

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase   = createClient()
  const cookieStore = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const { data: existing } = await supabase
    .from('agents')
    .select('id')
    .eq('id', params.id)
    .eq('group_id', activeGroupId)
    .single()
  if (!existing) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId)
    .single()
  const isAdmin = membership?.role === 'super_admin' || membership?.role === 'group_owner' || membership?.role === 'group_admin'
  if (!isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const admin = createAdminClient()
  await admin.from('agents').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', params.id)

  return NextResponse.json({ data: { id: params.id, is_active: false } })
}
