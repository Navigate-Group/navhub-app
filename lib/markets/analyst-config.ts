/**
 * Market Analyst configuration helpers (MKT-5) — server-side only.
 * ──────────────────────────────────────────────────────────────────────────
 * The Market Analyst agent is configurable: an operator can turn it on/off,
 * change the model, override the system prompt, edit the suggested questions
 * and set the cache TTL. These settings live in the singleton
 * `market_analyst_config` row (migration 074).
 *
 * Canonical DEFAULTS come from the bundled `markets_sample.json`
 * (`config.agent`) — the same document the explorer and compute layer read —
 * so the agent works out of the box before any admin override exists.
 *
 * An in-memory cache avoids re-reading the DB on every request. The row rarely
 * changes, so a short TTL (plus an explicit invalidation on write) is plenty.
 *
 * ⚠️  Import only in server-side code. Reads/writes use the service-role admin
 *     client so the config is available to the agent routes regardless of the
 *     caller's RLS context (role gating happens at the route boundary).
 */

import sample from '../../markets_sample.json' with { type: 'json' }
import { createAdminClient } from '../supabase/admin'

// ── Canonical defaults from the sample document ─────────────────────────────

interface SampleAgentConfig {
  name?: string
  analysis_prompt?: string
  chat_prompt?: string
  suggestions?: string[]
}

const SAMPLE_AGENT = ((sample as { config?: { agent?: SampleAgentConfig } }).config?.agent
  ?? {}) as SampleAgentConfig

/** The default chat system prompt (from the sample's config.agent.chat_prompt). */
export const DEFAULT_CHAT_PROMPT = SAMPLE_AGENT.chat_prompt ?? ''

/** The default model used when the config row has none set. */
export const DEFAULT_MODEL = 'claude-sonnet-4-6'

/** The default cache TTL (hours) when the config row has none set. */
export const DEFAULT_CACHE_TTL_HOURS = 24

/** The default suggested questions (from the sample's config.agent.suggestions). */
export const DEFAULT_SUGGESTIONS: string[] = (SAMPLE_AGENT.suggestions ?? []).slice()

// ── Resolved config shape ───────────────────────────────────────────────────

export interface AnalystConfig {
  enabled: boolean
  model: string
  /** The chat system prompt (DB override, else the sample default). */
  prompt: string
  suggestedQuestions: string[]
  cacheTtlHours: number
}

// ── In-memory cache (avoid repeated DB reads) ───────────────────────────────

let cached: { value: AnalystConfig; at: number } | null = null
const CACHE_MS = 60_000 // 1 minute — the row changes rarely.

/** Drop the in-memory config cache (called after a write). */
export function invalidateAnalystConfigCache(): void {
  cached = null
}

interface ConfigRow {
  enabled: boolean | null
  model: string | null
  prompt: string | null
  suggested_questions: unknown
  cache_ttl_hours: number | null
}

function resolveRow(row: ConfigRow | null): AnalystConfig {
  const suggestions = Array.isArray(row?.suggested_questions)
    ? (row!.suggested_questions as unknown[]).filter((s): s is string => typeof s === 'string')
    : []
  return {
    enabled: row?.enabled ?? true,
    model: row?.model || DEFAULT_MODEL,
    prompt: (row?.prompt && row.prompt.trim().length > 0) ? row.prompt : DEFAULT_CHAT_PROMPT,
    suggestedQuestions: suggestions.length > 0 ? suggestions : DEFAULT_SUGGESTIONS.slice(),
    cacheTtlHours:
      typeof row?.cache_ttl_hours === 'number' && row.cache_ttl_hours > 0
        ? row.cache_ttl_hours
        : DEFAULT_CACHE_TTL_HOURS,
  }
}

/**
 * Load the Market Analyst config, merging DB overrides over the sample
 * defaults. Served from the in-memory cache when fresh. On any DB error the
 * safe defaults are returned (never throws) so the agent degrades gracefully.
 */
export async function getAnalystConfig(): Promise<AnalystConfig> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value

  let value: AnalystConfig
  try {
    const admin = createAdminClient()
    const { data } = await admin
      .from('market_analyst_config')
      .select('enabled, model, prompt, suggested_questions, cache_ttl_hours')
      .eq('id', 1)
      .maybeSingle()
    value = resolveRow((data as ConfigRow | null) ?? null)
  } catch {
    value = resolveRow(null)
  }

  cached = { value, at: Date.now() }
  return value
}

/** Fields an operator may update on the config row. */
export interface AnalystConfigUpdate {
  enabled?: boolean
  model?: string
  prompt?: string | null
  suggestedQuestions?: string[]
  cacheTtlHours?: number
}

/**
 * Persist config changes to the singleton row and invalidate the in-memory
 * cache. Returns the freshly resolved config. Uses the service-role client so
 * the admin surface owns writes; route-level role gating authorises the caller.
 */
export async function setAnalystConfig(update: AnalystConfigUpdate): Promise<AnalystConfig> {
  const admin = createAdminClient()
  const patch: Record<string, unknown> = { id: 1, updated_at: new Date().toISOString() }
  if (update.enabled !== undefined) patch.enabled = update.enabled
  if (update.model !== undefined) patch.model = update.model
  if (update.prompt !== undefined) patch.prompt = update.prompt
  if (update.suggestedQuestions !== undefined) patch.suggested_questions = update.suggestedQuestions
  if (update.cacheTtlHours !== undefined) patch.cache_ttl_hours = update.cacheTtlHours

  await admin.from('market_analyst_config').upsert(patch, { onConflict: 'id' })
  invalidateAnalystConfigCache()
  return getAnalystConfig()
}
