import { NextResponse }     from 'next/server'
import { createClient }     from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { decrypt }          from '@/lib/encryption'

/**
 * POST /api/admin/provider-configs/{provider}/test
 *   → tests the provider API key by making a simple API call
 */

export async function POST(
  req: Request,
  { params }: { params: { provider: string } }
) {
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

  const provider = params.provider?.trim().toLowerCase()
  if (!provider) {
    return NextResponse.json({ ok: false, status: 400, message: 'Provider is required' })
  }

  const admin = createAdminClient()
  const { data: config } = await admin
    .from('superadmin_provider_configs')
    .select('api_key_encrypted, base_url')
    .eq('provider', provider)
    .eq('is_active', true)
    .maybeSingle()

  if (!config) {
    return NextResponse.json({ ok: false, status: 404, message: 'Provider not configured' })
  }

  let apiKey: string
  try {
    apiKey = decrypt(config.api_key_encrypted as string)
  } catch {
    return NextResponse.json({ ok: false, status: 500, message: 'Failed to decrypt API key' })
  }

  // Test the connection based on provider
  try {
    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        body: JSON.stringify({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 10,
          messages:   [{ role: 'user', content: 'Hi' }],
        }),
      })
      if (res.ok) {
        return NextResponse.json({ ok: true, status: 200, message: 'Connected successfully' })
      }
      const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
      return NextResponse.json({ ok: false, status: res.status, message: err.error?.message ?? res.statusText })
    }

    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      })
      if (res.ok) {
        return NextResponse.json({ ok: true, status: 200, message: 'Connected successfully' })
      }
      const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
      return NextResponse.json({ ok: false, status: res.status, message: err.error?.message ?? res.statusText })
    }

    if (provider === 'google') {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`)
      if (res.ok) {
        return NextResponse.json({ ok: true, status: 200, message: 'Connected successfully' })
      }
      const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
      return NextResponse.json({ ok: false, status: res.status, message: err.error?.message ?? res.statusText })
    }

    if (provider === 'mistral') {
      const res = await fetch('https://api.mistral.ai/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      })
      if (res.ok) {
        return NextResponse.json({ ok: true, status: 200, message: 'Connected successfully' })
      }
      const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
      return NextResponse.json({ ok: false, status: res.status, message: err.error?.message ?? res.statusText })
    }

    if (provider === 'custom') {
      const baseUrl = (config.base_url as string | null) ?? ''
      if (!baseUrl) {
        return NextResponse.json({ ok: false, status: 400, message: 'Base URL not configured' })
      }
      const res = await fetch(`${baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      })
      if (res.ok) {
        return NextResponse.json({ ok: true, status: 200, message: 'Connected successfully' })
      }
      return NextResponse.json({ ok: false, status: res.status, message: res.statusText })
    }

    return NextResponse.json({ ok: false, status: 400, message: 'Unknown provider' })
  } catch (err) {
    return NextResponse.json({ ok: false, status: 500, message: String(err) })
  }
}
