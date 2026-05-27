import { NextResponse }     from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { decrypt }           from '@/lib/encryption'

/**
 * POST /api/settings/provider-configs/[provider]/test
 * Sends a minimal request to the provider's API to verify the stored key works.
 */
export const runtime = 'nodejs'

async function testAnthropic(apiKey: string) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages:   [{ role: 'user', content: 'ping' }],
    }),
  })
  if (res.ok) return { ok: true, status: res.status, message: 'Connected' }
  const txt = await res.text().catch(() => '')
  return { ok: false, status: res.status, message: txt.slice(0, 200) || res.statusText }
}

async function testOpenAI(apiKey: string, baseUrl?: string | null) {
  const url = (baseUrl?.replace(/\/+$/, '') ?? 'https://api.openai.com/v1') + '/models'
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (res.ok) return { ok: true, status: res.status, message: 'Connected' }
  const txt = await res.text().catch(() => '')
  return { ok: false, status: res.status, message: txt.slice(0, 200) || res.statusText }
}

async function testGoogle(apiKey: string) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
  )
  if (res.ok) return { ok: true, status: res.status, message: 'Connected' }
  const txt = await res.text().catch(() => '')
  return { ok: false, status: res.status, message: txt.slice(0, 200) || res.statusText }
}

async function testMistral(apiKey: string) {
  const res = await fetch('https://api.mistral.ai/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (res.ok) return { ok: true, status: res.status, message: 'Connected' }
  const txt = await res.text().catch(() => '')
  return { ok: false, status: res.status, message: txt.slice(0, 200) || res.statusText }
}

export async function POST(_req: Request, { params }: { params: { provider: string } }) {
  const supabase     = createClient()
  const cookieStore  = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  const { data: { session } } = await supabase.auth.getSession()
  if (!session)       return NextResponse.json({ error: 'Unauthorized' },    { status: 401 })
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

  const admin = createAdminClient()
  const { data: cfg } = await admin
    .from('group_provider_configs')
    .select('api_key_encrypted, base_url')
    .eq('group_id', activeGroupId)
    .eq('provider', params.provider)
    .eq('is_active', true)
    .maybeSingle()

  if (!cfg) return NextResponse.json({ ok: false, status: 404, message: 'Provider not configured' })

  let apiKey: string
  try { apiKey = decrypt(cfg.api_key_encrypted) }
  catch { return NextResponse.json({ ok: false, status: 0, message: 'Stored key could not be decrypted' }) }

  try {
    let result
    switch (params.provider) {
      case 'anthropic': result = await testAnthropic(apiKey);                          break
      case 'openai':    result = await testOpenAI(apiKey, cfg.base_url);                break
      case 'google':    result = await testGoogle(apiKey);                              break
      case 'mistral':   result = await testMistral(apiKey);                             break
      case 'custom':    result = await testOpenAI(apiKey, cfg.base_url);                break
      default:          result = { ok: false, status: 400, message: 'Unknown provider' }
    }
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ ok: false, status: 0, message: msg })
  }
}
