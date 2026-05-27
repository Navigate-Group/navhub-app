import { NextResponse }     from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { encrypt }           from '@/lib/encryption'

/**
 * PATCH  /api/settings/model-configs/[id]  → update label/provider/model_name/is_default; re-encrypt api_key if supplied
 * DELETE /api/settings/model-configs/[id]  → soft delete (is_active=false). Refuses if any active agent references it.
 */

const VALID_PROVIDERS = ['anthropic', 'openai', 'google', 'mistral', 'custom']

async function adminGuard(supabase: ReturnType<typeof createClient>, userId: string, groupId: string) {
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', userId)
    .eq('group_id', groupId)
    .single()
  return !!membership && ['super_admin', 'group_owner', 'group_admin'].includes(membership.role)
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const supabase     = createClient()
  const cookieStore  = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  const { data: { session } } = await supabase.auth.getSession()
  if (!session)       return NextResponse.json({ error: 'Unauthorized' },    { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })
  if (!(await adminGuard(supabase, session.user.id, activeGroupId))) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const admin = createAdminClient()
  const { data: existing } = await admin
    .from('group_model_configs')
    .select('id, group_id')
    .eq('id', params.id)
    .eq('group_id', activeGroupId)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Config not found' }, { status: 404 })

  const body = await req.json() as {
    label?:      string
    provider?:   string
    model_name?: string
    api_key?:    string
    is_default?: boolean
  }

  const updates: Record<string, unknown> = {}
  if (body.label?.trim())      updates.label      = body.label.trim()
  if (body.provider?.trim()) {
    const p = body.provider.trim().toLowerCase()
    if (!VALID_PROVIDERS.includes(p)) {
      return NextResponse.json({ error: `Invalid provider` }, { status: 400 })
    }
    updates.provider = p
  }
  if (body.model_name?.trim()) updates.model_name = body.model_name.trim()
  if (body.api_key?.trim())    updates.api_key_encrypted = encrypt(body.api_key.trim())

  // is_default toggle: if true, clear all other defaults first
  if (body.is_default === true) {
    await admin
      .from('group_model_configs')
      .update({ is_default: false })
      .eq('group_id', activeGroupId)
      .eq('is_default', true)
    updates.is_default = true
  } else if (body.is_default === false) {
    updates.is_default = false
  }

  const { data, error } = await admin
    .from('group_model_configs')
    .update(updates)
    .eq('id', params.id)
    .select('id, group_id, label, provider, model_name, is_default, is_active, created_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data: { ...data, api_key_masked: '••••••••••••••••' } })
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const supabase     = createClient()
  const cookieStore  = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  const { data: { session } } = await supabase.auth.getSession()
  if (!session)       return NextResponse.json({ error: 'Unauthorized' },    { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })
  if (!(await adminGuard(supabase, session.user.id, activeGroupId))) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const admin = createAdminClient()

  // Refuse deletion when active agents still reference this config
  const { count } = await admin
    .from('agents')
    .select('id', { count: 'exact', head: true })
    .eq('model_config_id', params.id)
    .eq('is_active', true)

  if ((count ?? 0) > 0) {
    return NextResponse.json({
      error: `Cannot delete — ${count} active agent(s) use this model. Reassign them first.`,
    }, { status: 422 })
  }

  const { error } = await admin
    .from('group_model_configs')
    .update({ is_active: false, is_default: false })
    .eq('id', params.id)
    .eq('group_id', activeGroupId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
