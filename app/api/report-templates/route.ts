import { NextResponse }      from 'next/server'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { cookies }           from 'next/headers'

export const runtime = 'nodejs'

// ─── GET /api/report-templates ───────────────────────────────────────────────

export async function GET() {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const { data, error } = await supabase
    .from('report_templates')
    .select('id, name, description, template_type, version, design_tokens, slots, data_sources, created_by, agent_run_id, is_active, created_at, updated_at')
    .eq('group_id', activeGroupId)
    .eq('is_active', true)
    .order('updated_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data: data ?? [] })
}

// ─── POST /api/report-templates ──────────────────────────────────────────────

export async function POST(request: Request) {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  // Admin check
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId)
    .single()
  if (!membership || !['super_admin', 'group_owner', 'group_admin'].includes(membership.role)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  let body: Record<string, unknown>
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { name, description, template_type, design_tokens, slots, scaffold_html, scaffold_css, scaffold_js, data_sources, agent_instructions } = body

  if (!name || !template_type) {
    return NextResponse.json({ error: 'name and template_type are required' }, { status: 400 })
  }

  const validTypes = ['financial', 'matrix', 'narrative', 'dashboard', 'workflow']
  if (!validTypes.includes(template_type as string)) {
    return NextResponse.json({ error: 'Invalid template_type' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('report_templates')
    .insert({
      group_id:           activeGroupId,
      name,
      description:        description ?? null,
      template_type,
      version:            1,
      design_tokens:      design_tokens ?? {},
      slots:              slots ?? [],
      scaffold_html:      scaffold_html ?? null,
      scaffold_css:       scaffold_css ?? null,
      scaffold_js:        scaffold_js ?? null,
      data_sources:       data_sources ?? [],
      agent_instructions: agent_instructions ?? null,
      created_by:         session.user.id,
      updated_at:         new Date().toISOString(),
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data }, { status: 201 })
}
