import { NextResponse }     from 'next/server'
import { createClient }     from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { encrypt }          from '@/lib/encryption'

/**
 * GET  /api/admin/provider-configs
 *   → returns one row per supported provider, with is_configured flag.
 *     Keys are NEVER returned — only a masked indicator.
 *
 * POST /api/admin/provider-configs
 *   body: { provider, api_key, base_url? }
 *   → upserts the provider's key at the platform level (superadmin_provider_configs).
 */

const ALL_PROVIDERS = ['anthropic', 'openai', 'google', 'mistral', 'custom'] as const

export async function GET() {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Check superadmin role
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .single()
  if (!membership || membership.role !== 'super_admin') {
    return NextResponse.json({ error: 'Superadmin access required' }, { status: 403 })
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('superadmin_provider_configs')
    .select('id, provider, base_url, is_active, created_at')
    .eq('is_active', true)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const byProvider = new Map<string, { id: string; provider: string; base_url: string | null; created_at: string }>()
  for (const row of (data ?? []) as Array<{ id: string; provider: string; base_url: string | null; is_active: boolean; created_at: string }>) {
    byProvider.set(row.provider, row)
  }

  // Always return a row per supported provider so the UI can render placeholders
  const result = ALL_PROVIDERS.map(p => {
    const row = byProvider.get(p)
    return {
      provider:       p,
      is_configured:  !!row,
      base_url:       row?.base_url ?? null,
      api_key_masked: row ? '••••••••••••••••' : null,
      created_at:     row?.created_at ?? null,
      id:             row?.id ?? null,
    }
  })

  return NextResponse.json({ data: result })
}

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Check superadmin role
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .single()
  if (!membership || membership.role !== 'super_admin') {
    return NextResponse.json({ error: 'Superadmin access required' }, { status: 403 })
  }

  const body = await req.json() as { provider?: string; api_key?: string; base_url?: string }
  const provider = body.provider?.trim().toLowerCase()
  const apiKey   = body.api_key?.trim()

  if (!provider || !ALL_PROVIDERS.includes(provider as typeof ALL_PROVIDERS[number])) {
    return NextResponse.json({ error: 'Invalid provider' }, { status: 400 })
  }
  if (!apiKey) {
    return NextResponse.json({ error: 'api_key is required' }, { status: 400 })
  }

  const admin = createAdminClient()

  // Upsert by provider (unique constraint)
  const { data: existing } = await admin
    .from('superadmin_provider_configs')
    .select('id')
    .eq('provider', provider)
    .maybeSingle()

  const payload: Record<string, unknown> = {
    api_key_encrypted: encrypt(apiKey),
    is_active:         true,
    updated_at:        new Date().toISOString(),
  }
  if (provider === 'custom') payload.base_url = body.base_url?.trim() || null

  let saved
  if (existing) {
    saved = await admin
      .from('superadmin_provider_configs')
      .update(payload)
      .eq('id', existing.id)
      .select('id, provider, base_url, created_at')
      .single()
  } else {
    saved = await admin
      .from('superadmin_provider_configs')
      .insert({ provider, ...payload })
      .select('id, provider, base_url, created_at')
      .single()
  }

  if (saved.error) return NextResponse.json({ error: saved.error.message }, { status: 500 })

  return NextResponse.json({
    data: {
      ...saved.data,
      is_configured:  true,
      api_key_masked: '••••••••••••••••',
    },
  }, { status: 201 })
}
