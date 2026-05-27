import { NextResponse }     from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { decrypt }           from '@/lib/encryption'

/**
 * POST /api/settings/model-configs/[id]/test
 * Sends a minimal request to the provider's API to verify the key works.
 * Returns { ok, status, message } — never returns the API key itself.
 */

export const runtime = 'nodejs'

async function testAnthropic(apiKey: string, modelName: string) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      modelName,
      max_tokens: 1,
      messages:   [{ role: 'user', content: 'ping' }],
    }),
  })
  if (res.ok) return { ok: true, status: res.status, message: 'Connected' }
  const txt = await res.text().catch(() => '')
  return { ok: false, status: res.status, message: txt.slice(0, 200) || res.statusText }
}

async function testOpenAI(apiKey: string) {
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (res.ok) return { ok: true, status: res.status, message: 'Connected' }
  const txt = await res.text().catch(() => '')
  return { ok: false, status: res.status, message: txt.slice(0, 200) || res.statusText }
}

async function testGoogle(apiKey: string, modelName: string) {
  // Google AI Studio (Gemini) — list models endpoint
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}?key=${encodeURIComponent(apiKey)}`)
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

export async function POST(_req: Request, { params }: { params: { id: string } }) {
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
    .from('group_model_configs')
    .select('provider, model_name, api_key_encrypted')
    .eq('id', params.id)
    .eq('group_id', activeGroupId)
    .maybeSingle()
  if (!cfg) return NextResponse.json({ error: 'Config not found' }, { status: 404 })

  let apiKey: string
  try { apiKey = decrypt(cfg.api_key_encrypted) }
  catch { return NextResponse.json({ ok: false, status: 0, message: 'Stored key could not be decrypted' }) }

  try {
    let result: { ok: boolean; status: number; message: string }
    switch (cfg.provider) {
      case 'anthropic': result = await testAnthropic(apiKey, cfg.model_name); break
      case 'openai':    result = await testOpenAI(apiKey);                    break
      case 'google':    result = await testGoogle(apiKey, cfg.model_name);    break
      case 'mistral':   result = await testMistral(apiKey);                   break
      default:          result = { ok: false, status: 0, message: 'Test unsupported for "custom" provider' }
    }
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ ok: false, status: 0, message: msg })
  }
}
