import { NextResponse }     from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

// ── GET /api/agents ──────────────────────────────────────────────────────────
// List all active agents for the active group

export async function GET() {
  const supabase   = createClient()
  const cookieStore = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  // Filter: public agents + user's own private agents
  const { data: agents, error } = await supabase
    .from('agents')
    .select('*')
    .eq('group_id', activeGroupId)
    .eq('is_active', true)
    .or(`visibility.eq.public,created_by.eq.${session.user.id},created_by.is.null`)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data: agents ?? [] })
}

// ── POST /api/agents ─────────────────────────────────────────────────────────
// Create a new agent (admin only)

export async function POST(request: Request) {
  const supabase   = createClient()
  const cookieStore = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  // Verify admin role
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

  const { name } = body
  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'Agent name is required' }, { status: 422 })
  }

  const admin = createAdminClient()

  const { data: agent, error } = await admin
    .from('agents')
    .insert({
      group_id:           activeGroupId,
      name:               (name as string).trim(),
      description:        typeof body.description        === 'string' ? body.description.trim() || null : null,
      avatar_color:       typeof body.avatar_color       === 'string' ? body.avatar_color       : '#6366f1',
      model:              typeof body.model              === 'string' ? body.model              : 'claude-sonnet-4-20250514',
      persona_preset:     typeof body.persona_preset     === 'string' ? body.persona_preset     : 'custom',
      persona:            typeof body.persona            === 'string' ? body.persona.trim() || null : null,
      instructions:       typeof body.instructions       === 'string' ? body.instructions.trim() || null : null,
      tools:              Array.isArray(body.tools)      ? body.tools  : [],
      company_scope:      Array.isArray(body.company_scope) && body.company_scope.length > 0 ? body.company_scope : null,
      email_address:      typeof body.email_address      === 'string' ? body.email_address.trim() || null : null,
      email_display_name: typeof body.email_display_name === 'string' ? body.email_display_name.trim() || null : null,
      email_recipients:   Array.isArray(body.email_recipients) && body.email_recipients.length > 0 ? body.email_recipients : null,
      slack_channel:      typeof body.slack_channel      === 'string' ? body.slack_channel.trim() || null : null,
      model_config_id:    typeof body.model_config_id    === 'string' ? body.model_config_id    : null,
      ai_provider:        typeof body.ai_provider        === 'string' ? body.ai_provider        : 'anthropic',
      ai_model:           typeof body.ai_model           === 'string' ? body.ai_model           : 'claude-haiku-4-5-20251001',
      // Optional FK → agent_templates (migration 060). Set when this agent
      // was created from a platform template; the runner injects the
      // template's persona / instructions / skills / knowledge at run time.
      template_id:        typeof body.template_id        === 'string' && body.template_id.trim() ? body.template_id : null,
      created_by:         session.user.id,
    })
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data: agent }, { status: 201 })
}
