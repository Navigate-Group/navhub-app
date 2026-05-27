import { NextResponse }      from 'next/server'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { cookies }           from 'next/headers'

export const runtime = 'nodejs'

async function verifyTemplateAccess(
  supabase:    ReturnType<typeof createClient>,
  templateId:  string,
  activeGroupId: string | undefined
) {
  const { data } = await supabase
    .from('report_templates')
    .select('id, group_id')
    .eq('id', templateId)
    .eq('group_id', activeGroupId ?? '')
    .single()
  return data
}

// ─── GET /api/report-templates/[id] ──────────────────────────────────────────

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const { data, error } = await supabase
    .from('report_templates')
    .select('*')
    .eq('id', params.id)
    .eq('group_id', activeGroupId ?? '')
    .single()

  if (error || !data) return NextResponse.json({ error: 'Template not found' }, { status: 404 })
  return NextResponse.json({ data })
}

// ─── PATCH /api/report-templates/[id] ────────────────────────────────────────

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  // Admin check
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId ?? '')
    .single()
  if (!membership || !['super_admin', 'group_owner', 'group_admin'].includes(membership.role)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const existing = await verifyTemplateAccess(supabase, params.id, activeGroupId)
  if (!existing) return NextResponse.json({ error: 'Template not found' }, { status: 404 })

  let body: Record<string, unknown>
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const admin = createAdminClient()

  // Save current version to report_template_versions before updating
  const { data: currentFull } = await supabase
    .from('report_templates')
    .select('version, design_tokens, slots, scaffold_html, scaffold_css, scaffold_js')
    .eq('id', params.id)
    .single()

  if (currentFull) {
    void admin.from('report_template_versions').insert({
      template_id:   params.id,
      version:       currentFull.version,
      design_tokens: currentFull.design_tokens,
      slots:         currentFull.slots,
      scaffold_html: currentFull.scaffold_html,
      scaffold_css:  currentFull.scaffold_css,
      scaffold_js:   currentFull.scaffold_js,
      saved_by:      session.user.id,
    })
  }

  const allowedFields = [
    'name', 'description', 'template_type',
    'design_tokens', 'slots', 'scaffold_html', 'scaffold_css', 'scaffold_js',
    'data_sources', 'agent_instructions',
  ]
  const updates: Record<string, unknown> = {
    version:    (currentFull?.version ?? 0) + 1,
    updated_at: new Date().toISOString(),
  }
  for (const key of allowedFields) {
    if (key in body) updates[key] = body[key]
  }

  const { data, error } = await admin
    .from('report_templates')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data })
}

// ─── DELETE /api/report-templates/[id] ───────────────────────────────────────

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId ?? '')
    .single()
  if (!membership || !['super_admin', 'group_owner', 'group_admin'].includes(membership.role)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const existing = await verifyTemplateAccess(supabase, params.id, activeGroupId)
  if (!existing) return NextResponse.json({ error: 'Template not found' }, { status: 404 })

  const admin = createAdminClient()
  const { error } = await admin
    .from('report_templates')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data: { id: params.id } })
}
