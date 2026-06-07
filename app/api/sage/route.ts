/**
 * Sage ↔ Kaizen Contract — Inbound lanes (Phase 1)
 *
 * Handles:
 *   POST /api/sage/trigger       — Kaizen triggers a review (lane 1)
 *   POST /api/sage/health        — Kaizen pings health (lane 3)
 *   POST /api/sage/status-return — Kaizen returns escalation status (lane 5)
 *
 * All lanes require HMAC-SHA256 authentication with SAGE_SHARED_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyHmac } from '@/lib/sage-contract'
import { runSageScan } from '@/lib/sage-runner'
import { createAdminClient } from '@/lib/supabase/admin'
import type {
  TriggerReviewPayload,
  HealthPayload,
  StatusReturnPayload,
} from '@/lib/sage-contract'

/**
 * POST /api/sage/trigger — Inbound review trigger from Kaizen (lane 1)
 */
export async function POST(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Route to appropriate handler
  if (pathname === '/api/sage/trigger')       return handleTrigger(req)
  if (pathname === '/api/sage/health')        return handleHealthPing(req)
  if (pathname === '/api/sage/status-return') return handleStatusReturn(req)

  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

// ────────────────────────────────────────────────────────────────────────────
// Lane 1: Trigger review (inbound)
// ────────────────────────────────────────────────────────────────────────────

async function handleTrigger(req: NextRequest): Promise<NextResponse> {
  const { payload, error } = await verifyRequest<TriggerReviewPayload>(req)
  if (error) return error

  try {
    // Queue async scan with request_id from Kaizen
    const scanId = await runSageScan(
      payload.review_type,
      null, // triggered_by (null = external trigger)
      7,    // default 7-day period for triggered scans
      null, // focus_area
      payload.request_id, // NEW: pass request_id to runner
    )

    return NextResponse.json({
      status:     'queued',
      request_id: payload.request_id,
      scan_id:    scanId,
    })
  } catch (err) {
    console.error('[sage-contract] Trigger failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Trigger failed' },
      { status: 500 },
    )
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Lane 3: Health ping (inbound)
// ────────────────────────────────────────────────────────────────────────────

async function handleHealthPing(req: NextRequest): Promise<NextResponse> {
  const { error } = await verifyRequest<HealthPayload>(req)
  if (error) return error

  try {
    const admin = createAdminClient()
    const { data: lastScan } = await admin
      .from('sage_scans')
      .select('completed_at, status')
      .eq('status', 'complete')
      .order('completed_at', { ascending: false })
      .limit(1)
      .single()

    const appSlug = process.env.SAGE_APP_SLUG ?? 'navhub'
    const sageVersion = process.env.SAGE_VERSION ?? '1.0.0-phase1'

    return NextResponse.json({
      app:            appSlug,
      status:         'healthy',
      last_review_at: lastScan?.completed_at ?? null,
      sage_version:   sageVersion,
      ts:             new Date().toISOString(),
    })
  } catch (err) {
    console.error('[sage-contract] Health ping failed:', err)
    return NextResponse.json({
      app:    process.env.SAGE_APP_SLUG ?? 'navhub',
      status: 'error',
      last_review_at: null,
      sage_version: process.env.SAGE_VERSION ?? '1.0.0-phase1',
      ts: new Date().toISOString(),
    })
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Lane 5: Status-return (inbound)
// ────────────────────────────────────────────────────────────────────────────

async function handleStatusReturn(req: NextRequest): Promise<NextResponse> {
  const { payload, error } = await verifyRequest<StatusReturnPayload>(req)
  if (error) return error

  try {
    const admin = createAdminClient()

    // Find escalation by kaizen_escalation_id
    const { data: escalation } = await admin
      .from('sage_escalations')
      .select('id')
      .eq('kaizen_escalation_id', payload.escalation_id)
      .single()

    if (!escalation) {
      return NextResponse.json(
        { error: 'Escalation not found' },
        { status: 404 },
      )
    }

    // Update status and build_progress
    await admin
      .from('sage_escalations')
      .update({
        status:         payload.status,
        build_progress: payload.build_progress ?? null,
      })
      .eq('id', (escalation as { id: string }).id)

    return NextResponse.json({ status: 'ok' })
  } catch (err) {
    console.error('[sage-contract] Status-return failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Status-return failed' },
      { status: 500 },
    )
  }
}

// ────────────────────────────────────────────────────────────────────────────
// HMAC verification helper
// ────────────────────────────────────────────────────────────────────────────

async function verifyRequest<T>(req: NextRequest): Promise<
  | { payload: T; error?: never }
  | { payload?: never; error: NextResponse }
> {
  const signature = req.headers.get('x-sage-signature')
  const sharedSecret = process.env.SAGE_SHARED_SECRET

  if (!signature) {
    return {
      error: NextResponse.json(
        { error: 'Missing X-Sage-Signature header' },
        { status: 401 },
      ),
    }
  }

  if (!sharedSecret) {
    console.error('[sage-contract] SAGE_SHARED_SECRET not configured')
    return {
      error: NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 },
      ),
    }
  }

  const body = await req.text()

  if (!verifyHmac(body, signature, sharedSecret)) {
    return {
      error: NextResponse.json(
        { error: 'Invalid signature' },
        { status: 401 },
      ),
    }
  }

  try {
    const payload = JSON.parse(body) as T
    return { payload }
  } catch {
    return {
      error: NextResponse.json(
        { error: 'Invalid JSON' },
        { status: 400 },
      ),
    }
  }
}
