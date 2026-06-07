import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { signPayload } from '@/lib/sage-contract'

/**
 * POST /api/sage/test-connection — Validate Sage contract connection
 *
 * Accepts connection config in the request body (for testing unsaved changes)
 * or uses saved database settings. Makes an authenticated health ping to
 * Builder's /api/sage/inbound/health endpoint to verify the connection.
 */
export async function POST(request: Request) {
  const supabase = createClient()

  // Verify super_admin
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: memberships } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('role', 'super_admin')

  if (!memberships || memberships.length === 0) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Parse request body (optional - if provided, test with these values instead of DB)
  const body = await request.json().catch(() => ({}))
  let builderUrl: string
  let sharedSecret: string
  let appSlug: string

  if (body.builder_url && body.shared_secret && body.app_slug) {
    // Test with provided config (unsaved changes)
    builderUrl = body.builder_url
    sharedSecret = body.shared_secret
    appSlug = body.app_slug
  } else {
    // Load from database
    const { data: settings, error: dbError } = await supabase
      .from('sage_settings')
      .select('*')
      .single()

    if (dbError) {
      console.error('[test-connection] Failed to load settings from DB:', dbError)
      return NextResponse.json(
        {
          error: 'Failed to load connection settings from database',
          details: dbError.message || dbError.hint || String(dbError)
        },
        { status: 500 }
      )
    }

    if (!settings) {
      return NextResponse.json(
        { error: 'No connection settings found. Please configure settings first.' },
        { status: 400 }
      )
    }

    console.log('[test-connection] Loaded settings from DB:', {
      builder_url: settings.builder_url,
      app_slug: settings.app_slug,
      has_secret: !!settings.shared_secret,
      secret_length: settings.shared_secret?.length
    })

    builderUrl = settings.builder_url
    sharedSecret = settings.shared_secret
    appSlug = settings.app_slug
  }

  // Validate fields
  if (!builderUrl || !sharedSecret || !appSlug) {
    return NextResponse.json(
      { error: 'Missing required connection parameters' },
      { status: 400 }
    )
  }

  // Build health ping payload
  const payload = {
    app: appSlug,
    status: 'healthy',
    last_review_at: null,
    sage_version: '1.0.0-phase1',
    ts: new Date().toISOString(),
  }

  const body_str = JSON.stringify(payload)
  const signature = signPayload(body_str, sharedSecret)

  console.log('[test-connection] Signing payload:', {
    payload_length: body_str.length,
    signature_length: signature.length,
    signature_preview: signature.substring(0, 16) + '...'
  })

  // POST to Builder's health endpoint
  const url = `${builderUrl}/api/sage/inbound/health`
  console.log('[test-connection] POSTing to:', url)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sage-Signature': signature,
        'X-Sage-Timestamp': new Date().toISOString(),
      },
      body: body_str,
      signal: AbortSignal.timeout(10_000), // 10s timeout
    })

    if (!res.ok) {
      const errorText = await res.text().catch(() => '')
      console.error('[test-connection] Builder returned error:', res.status, errorText)
      return NextResponse.json(
        {
          error: `Connection failed: Builder returned ${res.status}`,
          details: errorText.slice(0, 200),
        },
        { status: 502 }
      )
    }

    // Success!
    return NextResponse.json({
      success: true,
      message: 'Connection successful. Builder responded to health ping.',
    })
  } catch (err) {
    console.error('[test-connection] Network error:', err)
    return NextResponse.json(
      {
        error: 'Connection failed',
        details: err instanceof Error ? err.message : 'Network error',
      },
      { status: 502 }
    )
  }
}
