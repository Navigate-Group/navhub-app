/**
 * Sage ↔ Builder Agent Endpoint (Phase 1)
 *
 * Handles inbound agent commands from Builder:
 *   POST /api/sage/agent — HMAC-authenticated agent lanes
 *   GET  /api/sage/agent — Returns 401 (requires signature)
 *
 * Implements three lanes per Builder's dispatch contract:
 *   - ping: Health check / connection verification
 *   - trigger: Trigger a review and POST result back to Builder
 *   - status_return: Acknowledgement for escalation status updates (Phase 1)
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyHmac } from '@/lib/sage-contract'
import { createAdminClient } from '@/lib/supabase/admin'
import { runSageScan } from '@/lib/sage-runner'

// Extend NextRequest to include Vercel's waitUntil method
interface VercelNextRequest extends NextRequest {
  waitUntil?: (promise: Promise<unknown>) => void
}

interface AgentRequest {
  lane: string
  app: string
  [key: string]: unknown
}

interface TriggerRequest extends AgentRequest {
  lane: 'trigger'
  slug: string
  review_type: 'weekly' | 'daily' | 'adhoc' | 'alert' | 'requested'
  request_id?: string
}

interface StatusReturnRequest extends AgentRequest {
  lane: 'status_return'
  escalation_id: string
  status: string
  build_progress?: Record<string, unknown>
}

/**
 * GET /api/sage/agent — Returns 401 (all requests require signature)
 */
export async function GET() {
  return NextResponse.json(
    { error: 'Invalid signature' },
    { status: 401 },
  )
}

/**
 * POST /api/sage/agent — Inbound agent lanes from Builder
 */
export async function POST(req: VercelNextRequest) {
  console.log('[sage-agent] Received request:', req.url)

  // Read signature header (Builder uses x-builder-signature)
  const signature = req.headers.get('x-builder-signature')
  if (!signature) {
    console.log('[sage-agent] Missing x-builder-signature header')
    return NextResponse.json(
      { error: 'Invalid signature' },
      { status: 401 },
    )
  }

  // Read request body (raw bytes for signature verification)
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
  const supabase = createAdminClient()
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

  // Verify HMAC signature over raw request body bytes
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

  console.log('[sage-agent] Lane:', payload.lane)

  // Route to lane handlers
  if (payload.lane === 'ping') {
    return handlePing(settings.app_slug)
  }

  if (payload.lane === 'trigger') {
    return handleTrigger(payload as TriggerRequest, settings.app_slug, req)
  }

  if (payload.lane === 'status_return') {
    return handleStatusReturn(payload as StatusReturnRequest)
  }

  // Unknown lane
  console.log('[sage-agent] Unknown lane:', payload.lane)
  return NextResponse.json(
    { error: 'Unknown lane' },
    { status: 400 },
  )
}

/**
 * Handle ping lane — return health status
 */
function handlePing(appSlug: string): NextResponse {
  console.log('[sage-agent] Responding to ping')
  return NextResponse.json({
    lane: 'health',
    source_app: appSlug,
    status: 'ok',
    sage_version: `${appSlug}-sage-1.0.0`,
    ts: new Date().toISOString(),
  })
}

/**
 * Handle trigger lane — queue review and POST result back to Builder
 */
async function handleTrigger(
  payload: TriggerRequest,
  appSlug: string,
  req: VercelNextRequest,
): Promise<NextResponse> {
  console.log('[sage-agent] Trigger review:', payload.review_type)

  // Immediately acknowledge receipt
  const ackResponse = NextResponse.json({
    lane: 'ack',
    source_app: appSlug,
    status: 'queued',
    ts: new Date().toISOString(),
  })

  // Queue async review using waitUntil to ensure completion on Vercel serverless
  const reviewPromise = (async () => {
    try {
      const scanId = await runSageScan(
        payload.review_type,
        null, // triggered_by (null = external trigger)
        7,    // default 7-day period
        null, // focus_area
        payload.request_id ?? null,
      )

      console.log('[sage-agent] Review queued:', scanId)

      // After scan completes, POST result to Builder's inbound endpoint
      // This will be done by the existing sage-runner completion hook
    } catch (err) {
      console.error('[sage-agent] Trigger failed:', err)
    }
  })()

  // Use waitUntil to ensure the review completes even after the response is sent
  if (req.waitUntil) {
    req.waitUntil(reviewPromise)
  } else {
    // Fallback for local development (non-Vercel)
    reviewPromise.catch(err => console.error('[sage-agent] Unhandled review error:', err))
  }

  return ackResponse
}

/**
 * Handle status_return lane — acknowledge escalation status update (Phase 1)
 */
function handleStatusReturn(payload: StatusReturnRequest): NextResponse {
  console.log('[sage-agent] Status return:', payload.escalation_id, payload.status)

  // Phase 1: Just acknowledge — no database update needed yet
  return NextResponse.json({
    lane: 'ack',
    source_app: 'navhub',
    status: 'ok',
    ts: new Date().toISOString(),
  })
}
