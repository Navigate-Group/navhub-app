/**
 * Market Analyst shared server helpers (MKT-5) — server-side only.
 * ──────────────────────────────────────────────────────────────────────────
 * Common plumbing for the four `/api/markets/analyst/*` routes:
 *
 *   - requireMarketsViewer()  → role gating (401/403) mirroring the preferences
 *     route, returning the request-scoped Supabase client + user id.
 *   - logAnalystRun()         → write a row to market_analyst_runs via the
 *     service-role client (success or error), never throwing.
 *   - callClaudeStream()      → a focused streaming Anthropic call that tags
 *     figures, counts tokens from the response metadata, and surfaces
 *     timeout / rate-limit errors instead of swallowing them.
 *   - figureAttribution()     → format a figure's season + derivation note for
 *     inclusion in the view context handed to the model.
 *
 * ⚠️  Import only in server-side code (Route Handlers).
 */

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '../supabase/server'
import { createAdminClient } from '../supabase/admin'
import { getMarketsAccess, canViewMarkets } from '../markets'

export { figureAttribution, cellAttribution } from './analyst-helpers'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'

// ── Role gating ─────────────────────────────────────────────────────────────

export type ViewerContext =
  | { error: NextResponse }
  | { supabase: SupabaseClient; userId: string }

/**
 * Gate an analyst route to Markets viewers (viewer / manager / super admin).
 * Returns { error } with a 401/403 response, or { supabase, userId } on pass —
 * the SAME shape the existing /api/markets/preferences route uses.
 */
export async function requireMarketsViewer(): Promise<ViewerContext> {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { error: NextResponse.json({ error: 'Unauthorised' }, { status: 401 }) }
  }
  const access = await getMarketsAccess(supabase, user.id)
  if (!canViewMarkets(access)) {
    return { error: NextResponse.json({ error: 'Markets access required' }, { status: 403 }) }
  }
  return { supabase, userId: user.id }
}

// ── Run logging ─────────────────────────────────────────────────────────────

export interface AnalystRunLog {
  userId: string | null
  input: unknown
  output: string | null
  tokensUsed: number
  durationMs: number
  cached: boolean
  status: 'success' | 'error'
}

/**
 * Log an agent invocation to market_analyst_runs. Uses the service-role client
 * so logging always succeeds regardless of the caller's RLS context. Never
 * throws — a logging failure must not break the response.
 */
export async function logAnalystRun(run: AnalystRunLog): Promise<void> {
  try {
    const admin = createAdminClient()
    await admin.from('market_analyst_runs').insert({
      user_id: run.userId,
      input: run.input ?? {},
      output: run.output,
      tokens_used: Math.max(0, Math.round(run.tokensUsed)),
      duration_ms: Math.max(0, Math.round(run.durationMs)),
      cached: run.cached,
      type: 'market_analyst',
      tags: ['Markets'],
      status: run.status,
    })
  } catch {
    /* best-effort — never block the response on a logging failure */
  }
}

// ── Figure attribution ──────────────────────────────────────────────────────
// `figureAttribution` / `cellAttribution` are re-exported above from the pure
// `./analyst-helpers` module (unit-testable, dependency-free).

// ── Streaming Anthropic call ────────────────────────────────────────────────

export interface ClaudeStreamResult {
  text: string
  /** inputTokens + outputTokens, from the response metadata (accurate). */
  tokens: number
  inputTokens: number
  outputTokens: number
}

export interface ClaudeStreamOptions {
  model: string
  system: string
  userMessage: string
  maxTokens?: number
  /** overall request timeout (ms); default 120s. */
  timeoutMs?: number
  /** called for each text chunk as it streams in. */
  onChunk: (chunk: string) => void
}

/**
 * Error distinguishable as a rate limit so the route can surface a 429 to the
 * client rather than a generic 500.
 */
export class AnalystRateLimitError extends Error {
  retryAfter: number
  constructor(retryAfter: number) {
    super(`RATE_LIMITED:${retryAfter}`)
    this.name = 'AnalystRateLimitError'
    this.retryAfter = retryAfter
  }
}

/** Error distinguishable as a timeout/abort. */
export class AnalystTimeoutError extends Error {
  constructor(message = 'The analyst request timed out') {
    super(message)
    this.name = 'AnalystTimeoutError'
  }
}

/**
 * Stream a single-turn Anthropic message. Parses the SSE stream, calls
 * `onChunk` with each text delta, and reads accurate token counts from the
 * message_start (input) and message_delta (output) usage events — exactly like
 * the platform agent runner. Rate-limit (429) and timeout/abort errors are
 * raised as distinguishable exceptions so the caller can log + surface them.
 */
export async function callClaudeStream(opts: ClaudeStreamOptions): Promise<ClaudeStreamResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable not set')

  const controller = new AbortController()
  const timeoutMs = opts.timeoutMs ?? 120_000
  const timer = setTimeout(() => {
    try { controller.abort() } catch { /* ignore */ }
  }, timeoutMs)

  let res: Response
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 2_000,
        system: opts.system,
        messages: [{ role: 'user', content: opts.userMessage }],
        stream: true,
      }),
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    if (controller.signal.aborted) throw new AnalystTimeoutError()
    throw err
  }

  if (res.status === 429) {
    const retryHdr = res.headers.get('retry-after')
    const retryAfter = retryHdr ? parseInt(retryHdr, 10) : 10
    clearTimeout(timer)
    throw new AnalystRateLimitError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 10)
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    clearTimeout(timer)
    throw new Error(`Anthropic API ${res.status}: ${errBody.slice(0, 300)}`)
  }

  const reader = res.body?.getReader()
  if (!reader) {
    clearTimeout(timer)
    throw new Error('No response body from Anthropic API')
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''
  let inputTokens = 0
  let outputTokens = 0

  try {
    while (true) {
      let read: ReadableStreamReadResult<Uint8Array>
      try {
        read = await reader.read()
      } catch (err) {
        if (controller.signal.aborted) throw new AnalystTimeoutError()
        throw err
      }
      if (read.done) break

      buffer += decoder.decode(read.value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue

        let event: Record<string, unknown>
        try { event = JSON.parse(data) } catch { continue }

        const evType = event.type as string
        if (evType === 'message_start') {
          const msg = event.message as Record<string, unknown> | undefined
          const usage = msg?.usage as Record<string, number> | undefined
          if (usage) inputTokens = usage.input_tokens ?? 0
        } else if (evType === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown>
          if (delta?.type === 'text_delta') {
            const chunk = delta.text as string
            fullText += chunk
            opts.onChunk(chunk)
          }
        } else if (evType === 'message_delta') {
          const usage = event.usage as Record<string, number> | undefined
          if (usage) outputTokens = usage.output_tokens ?? outputTokens
        }
      }
    }
  } finally {
    clearTimeout(timer)
    try { reader.releaseLock() } catch { /* already released */ }
  }

  return {
    text: fullText,
    tokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
  }
}
