/**
 * Sage ↔ Kaizen Agent Endpoint (Phase 1)
 *
 * Handles inbound agent commands from Builder:
 *   POST /api/sage/agent — HMAC-authenticated agent actions
 *
 * Phase 1 implements only the 'ping' action for connection verification.
 * Future phases will add system_sweep, activity_review, investigation, escalation.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyHmac } from '@/lib/sage-contract'
import { createClient } from '@/lib/supabase/server'

interface AgentRequest {
  action: string
  [key: string]: unknown
}

/**
 * POST /api/sage/agent — Inbound agent actions from Builder
 */
export async function POST(req: NextRequest) {
  console.log('[sage-agent] Received request:', req.url)

  // Read signature header
  const signature = req.headers.get('x-sage-signature')
  if (!signature) {
    console.log('[sage-agent] Missing signature header')
    return NextResponse.json(
      { error: 'Invalid signature' },
      { status: 401 },
    )
  }

  // Read request body
  let body: string
  try {
    body = await req.text()
  } catch (err) {
    console.error('[sage-agent] Failed to read request body:', err)
    return NextResponse.json(
      { error: 'Invalid JSON' },
      { status: 400 },
    )
  }

  // Fetch shared secret from database
  const supabase = createClient()
  const { data: settings, error: dbError } = await supabase
    .from('sage_settings')
    .select('shared_secret, app_slug')
    .single()

  if (dbError || !settings || !settings.shared_secret) {
    console.error('[sage-agent] Failed to load shared secret from database:', dbError)
    return NextResponse.json(
      { error: 'Server configuration error' },
      { status: 500 },
    )
  }

  // Verify HMAC signature
  const isValid = verifyHmac(body, signature, settings.shared_secret)
  console.log('[sage-agent] Signature check:', isValid ? 'valid' : 'invalid')

  if (!isValid) {
    return NextResponse.json(
      { error: 'Invalid signature' },
      { status: 401 },
    )
  }

  // Parse JSON payload
  let payload: AgentRequest
  try {
    payload = JSON.parse(body) as AgentRequest
  } catch {
    console.error('[sage-agent] Malformed JSON in request body')
    return NextResponse.json(
      { error: 'Invalid JSON' },
      { status: 400 },
    )
  }

  console.log('[sage-agent] Action:', payload.action)

  // Route to action handlers
  if (payload.action === 'ping') {
    return handlePing(settings.app_slug)
  }

  // Unknown action
  console.log('[sage-agent] Unknown action:', payload.action)
  return NextResponse.json(
    { error: 'Unknown action' },
    { status: 400 },
  )
}

/**
 * Handle ping action — verify connection and return app identity
 */
function handlePing(appSlug: string): NextResponse {
  console.log('[sage-agent] Responding to ping with app identity:', appSlug)
  return NextResponse.json({
    app: appSlug,
    ok: true,
    ts: new Date().toISOString(),
  })
}
