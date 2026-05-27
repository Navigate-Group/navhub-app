import { NextResponse }     from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { encrypt }           from '@/lib/encryption'

/**
 * GET  /api/settings/model-configs   → list active model configs (api keys masked)
 * POST /api/settings/model-configs   → create model config (admin)
 */

const VALID_PROVIDERS = ['anthropic', 'openai', 'google', 'mistral', 'custom']

function maskKey(): string {
  return '••••••••••••••••'
}

export async function GET() {
  const supabase     = createClient()
  const cookieStore  = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  const { data: { session } } = await supabase.auth.getSession()
  if (!session)         return NextResponse.json({ error: 'Unauthorized' },       { status: 401 })
  if (!activeGroupId)   return NextResponse.json({ error: 'No active group' },    { status: 400 })

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('group_model_configs')
    .select('id, group_id, label, provider, model_name, is_default, is_active, created_at')
    .eq('group_id', activeGroupId)
    .eq('is_active', true)
    .order('is_default', { ascending: false })
    .order('label',      { ascending: true  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Add a masked key string for display
  const masked = (data ?? []).map(m => ({ ...m, api_key_masked: maskKey() }))
  return NextResponse.json({ data: masked })
}

export async function POST(req: Request) {
  const supabase     = createClient()
  const cookieStore  = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  const { data: { session } } = await supabase.auth.getSession()
  if (!session)       return NextResponse.json({ error: 'Unauthorized' },    { status: 401 })
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

  const body = await req.json() as {
    label?:      string
    provider?:   string
    model_name?: string
    api_key?:    string
    is_default?: boolean
  }

  const label      = body.label?.trim()
  const provider   = body.provider?.trim().toLowerCase()
  const modelName  = body.model_name?.trim()
  const apiKey     = body.api_key?.trim()

  if (!label || !provider || !modelName || !apiKey) {
    return NextResponse.json({ error: 'label, provider, model_name and api_key are required' }, { status: 400 })
  }
  if (!VALID_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(', ')}` }, { status: 400 })
  }

  const admin = createAdminClient()

  // If setting as default, clear others first
  if (body.is_default) {
    await admin
      .from('group_model_configs')
      .update({ is_default: false })
      .eq('group_id', activeGroupId)
      .eq('is_default', true)
  }

  const { data, error } = await admin
    .from('group_model_configs')
    .insert({
      group_id:          activeGroupId,
      label,
      provider,
      model_name:        modelName,
      api_key_encrypted: encrypt(apiKey),
      is_default:        !!body.is_default,
      created_by:        session.user.id,
    })
    .select('id, group_id, label, provider, model_name, is_default, is_active, created_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data: { ...data, api_key_masked: maskKey() } }, { status: 201 })
}
