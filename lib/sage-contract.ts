/**
 * Sage ↔ Kaizen Contract — HMAC-authenticated lanes (Phase 1)
 *
 * Implements the five contract lanes per docs/sage-contract.md §7:
 *   1. Trigger review (inbound)
 *   2. Review result (outbound)
 *   3. Health ping (bidirectional)
 *   4. Escalation (inbound trigger + outbound POST)
 *   5. Status-return (inbound)
 *
 * All lanes use HMAC-SHA256 authentication with SAGE_SHARED_SECRET.
 */

import { createHmac } from 'crypto'

const SAGE_VERSION = '1.0.0-phase1'

// ────────────────────────────────────────────────────────────────────────────
// HMAC authentication
// ────────────────────────────────────────────────────────────────────────────

/**
 * Sign a payload with HMAC-SHA256 using the shared secret.
 * Returns the signature as a hex string.
 */
export function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

/**
 * Verify an inbound request's HMAC signature.
 * Returns true if the signature matches the payload.
 */
export function verifyHmac(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const expected = signPayload(payload, secret)
  // Constant-time comparison to prevent timing attacks
  return timingSafeEqual(signature, expected)
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

// ────────────────────────────────────────────────────────────────────────────
// Contract message types
// ────────────────────────────────────────────────────────────────────────────

export interface TriggerReviewPayload {
  request_id:   string
  app:          string
  review_type:  'weekly' | 'daily' | 'adhoc' | 'alert' | 'requested'
  requested_at: string
}

export interface ReviewResultPayload {
  source_app:   string
  lane:         'review_result'
  request_id?:  string | null
  review_type:  'weekly' | 'daily' | 'adhoc' | 'alert' | 'requested'
  summary:      string
  findings:     Array<{
    severity:       'critical' | 'warning' | 'info' | 'positive'
    title:          string
    observation:    string
    interpretation: string
    recommendation: string | null
    affected_count: number | null
  }>
  ran_at:       string
  sage_version: string
}

export interface HealthPayload {
  source_app:     string
  lane:           'health'
  status:         'healthy' | 'degraded' | 'error'
  last_review_at: string | null
  sage_version:   string
  ts:             string
}

export interface EscalationPayload {
  source_app:        string
  lane:              'escalation'
  trigger_type:      'review' | 'user_report' | 'suggestion' | 'admin_interaction'
  summary:           string
  detail:            string
  suggested_priority: 'low' | 'medium' | 'high' | 'critical'
  source_context:    {
    scan_id?:    string
    finding_id?: string
    user_id?:    string
    group_id?:   string
  }
  ts: string
}

export interface StatusReturnPayload {
  escalation_id:   string
  status:          'acknowledged' | 'acted' | 'declined'
  build_progress?: {
    branch?:  string
    pr_url?:  string
    shipped?: boolean
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Outbound POST wrappers
// ────────────────────────────────────────────────────────────────────────────

interface OutboundConfig {
  builderUrl:    string
  sharedSecret:  string
  appSlug:       string
}

/**
 * POST review-result to Builder after a scan completes.
 * Implements contract lane 2 (outbound).
 */
export async function postReviewResult(
  config:  OutboundConfig,
  payload: Omit<ReviewResultPayload, 'source_app' | 'lane'>,
): Promise<void> {
  const fullPayload: ReviewResultPayload = {
    source_app: config.appSlug,
    lane: 'review_result',
    ...payload,
  }
  await postToBuilder(config, '/api/sage/inbound', fullPayload as unknown as Record<string, unknown>)
}

/**
 * POST health ping to Builder (hourly or on-demand).
 * Implements contract lane 3 (outbound).
 */
export async function postHealthPing(config: OutboundConfig): Promise<void> {
  const payload: HealthPayload = {
    source_app:     config.appSlug,
    lane:           'health',
    status:         'healthy',
    last_review_at: null, // TODO: query sage_scans for last completed_at
    sage_version:   SAGE_VERSION,
    ts:             new Date().toISOString(),
  }
  await postToBuilder(config, '/api/sage/inbound', payload as unknown as Record<string, unknown>)
}

/**
 * POST escalation to Builder.
 * Implements contract lane 4 (outbound).
 */
export async function postEscalation(
  config:  OutboundConfig,
  payload: Omit<EscalationPayload, 'source_app' | 'lane'>,
): Promise<void> {
  const fullPayload: EscalationPayload = {
    source_app: config.appSlug,
    lane: 'escalation',
    ...payload,
  }
  await postToBuilder(config, '/api/sage/inbound', fullPayload as unknown as Record<string, unknown>)
}

/**
 * Generic outbound POST with HMAC signing and retry logic.
 */
async function postToBuilder(
  config:   OutboundConfig,
  endpoint: string,
  payload:  Record<string, unknown>,
): Promise<void> {
  const url  = `${config.builderUrl}${endpoint}`
  const body = JSON.stringify(payload)
  const sig  = signPayload(body, config.sharedSecret)

  let lastError: Error | null = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: {
          'Content-Type':        'application/json',
          'x-builder-signature': sig,
          'X-Sage-Timestamp':    new Date().toISOString(),
        },
        body,
        signal: AbortSignal.timeout(30_000),
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`Builder ${endpoint} returned ${res.status}: ${errText.slice(0, 200)}`)
      }

      console.log(`[sage-contract] Posted to ${endpoint} (attempt ${attempt})`)
      return
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      console.warn(`[sage-contract] POST ${endpoint} attempt ${attempt} failed:`, lastError.message)
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
      }
    }
  }

  // All retries failed — log but don't throw (contract delivery is best-effort)
  console.error(`[sage-contract] Failed to POST ${endpoint} after 3 attempts:`, lastError?.message)
}

// ────────────────────────────────────────────────────────────────────────────
// Config helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Load contract config from database (preferred) with env var fallback.
 * Phase 1: Decouples connection config from deployment env vars.
 */
export async function getContractConfig(): Promise<OutboundConfig> {
  // Try database first
  try {
    // Dynamic import to avoid server-only module in edge/client contexts
    const { createClient } = await import('@/lib/supabase/server')
    const supabase = createClient()

    const { data: settings } = await supabase
      .from('sage_settings')
      .select('builder_url, shared_secret, app_slug')
      .single()

    if (settings && settings.builder_url && settings.shared_secret && settings.app_slug) {
      return {
        builderUrl: settings.builder_url,
        sharedSecret: settings.shared_secret,
        appSlug: settings.app_slug,
      }
    }
  } catch (err) {
    // Database read failed or no settings found — fall back to env vars
    console.warn('[sage-contract] Database config unavailable, falling back to env vars:', err instanceof Error ? err.message : String(err))
  }

  // Fallback to env vars (backward compatibility during transition)
  const builderUrl   = process.env.BUILDER_URL
  const sharedSecret = process.env.SAGE_SHARED_SECRET
  const appSlug      = process.env.SAGE_APP_SLUG

  if (!builderUrl)   throw new Error('BUILDER_URL not configured (check database or env vars)')
  if (!sharedSecret) throw new Error('SAGE_SHARED_SECRET not configured (check database or env vars)')
  if (!appSlug)      throw new Error('SAGE_APP_SLUG not configured (check database or env vars)')

  return { builderUrl, sharedSecret, appSlug }
}

/**
 * Get the Sage version identifier (sent in all outbound payloads).
 */
export function getSageVersion(): string {
  return SAGE_VERSION
}
