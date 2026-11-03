/**
 * Market Analyst — server-side config & usage helpers (MKT-5).
 * ──────────────────────────────────────────────────────────────────────────
 * Resolves the live Market Analyst configuration (enable flag, model, prompts,
 * suggested questions, cache TTL) and records token usage. The canonical
 * defaults live in the `config.agent` block of markets_sample.json (the MKT-2
 * seed); the `markets_agent_config` row (migration 074) overrides them when an
 * operator edits the admin config. Any empty override column falls back to the
 * seed, so the seed JSON stays the single source of truth until edited.
 *
 * ⚠️  Server-side only — imports the service-role admin client.
 */

import sample from '../../markets_sample.json' with { type: 'json' }
import { createAdminClient } from '../supabase/admin'
import type { AgentModel } from '../types'

const AGENT_KEY = 'analyst'

/** The canonical agent block seeded in markets_sample.json. */
interface SampleAgent {
  name?: string
  analysis_prompt?: string
  chat_prompt?: string
  suggestions?: string[]
}

function seedAgent(): SampleAgent {
  const cfg = (sample as { config?: { agent?: SampleAgent } }).config
  return cfg?.agent ?? {}
}

/** Models offered in the admin dropdown. Labels mirror the brief. */
export const ANALYST_MODELS: Array<{ value: AgentModel; label: string }> = [
  { value: 'claude-sonnet-4-20250514', label: 'Claude 3.5 Sonnet' },
  { value: 'claude-opus-4-20250514',   label: 'Claude 3 Opus' },
  { value: 'gpt-4o',                   label: 'GPT-4o' },
]

export interface AnalystConfig {
  enabled: boolean
  model: AgentModel
  analysisPrompt: string
  chatPrompt: string
  suggestions: string[]
  cacheTtlHours: number
}

/** The row shape persisted in markets_agent_config. */
interface ConfigRow {
  enabled: boolean
  model: string
  analysis_prompt: string
  chat_prompt: string
  suggestions: unknown
  cache_ttl_hours: number
}

function coerceModel(value: string | null | undefined): AgentModel {
  const known = ANALYST_MODELS.map(m => m.value)
  return (known as string[]).includes(value ?? '')
    ? (value as AgentModel)
    : 'claude-sonnet-4-20250514'
}

function coerceSuggestions(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
  return []
}

/**
 * Resolve the live analyst config, merging the DB override over the seed
 * defaults. Never throws — on any read error it returns the seed defaults with
 * `enabled: true` so the panel still works (and falls back to facts if the key
 * is absent).
 */
export async function getAnalystConfig(): Promise<AnalystConfig> {
  const seed = seedAgent()
  const defaults: AnalystConfig = {
    enabled: true,
    model: 'claude-sonnet-4-20250514',
    analysisPrompt: seed.analysis_prompt ?? '',
    chatPrompt: seed.chat_prompt ?? '',
    suggestions: seed.suggestions ?? [],
    cacheTtlHours: 24,
  }

  try {
    const admin = createAdminClient()
    const { data } = await admin
      .from('markets_agent_config')
      .select('enabled, model, analysis_prompt, chat_prompt, suggestions, cache_ttl_hours')
      .eq('agent_key', AGENT_KEY)
      .maybeSingle()
    if (!data) return defaults

    const row = data as ConfigRow
    const overrideSuggestions = coerceSuggestions(row.suggestions)
    return {
      enabled: row.enabled ?? defaults.enabled,
      model: coerceModel(row.model),
      analysisPrompt: row.analysis_prompt?.trim() ? row.analysis_prompt : defaults.analysisPrompt,
      chatPrompt: row.chat_prompt?.trim() ? row.chat_prompt : defaults.chatPrompt,
      suggestions: overrideSuggestions.length ? overrideSuggestions : defaults.suggestions,
      cacheTtlHours: Number.isFinite(row.cache_ttl_hours) ? row.cache_ttl_hours : defaults.cacheTtlHours,
    }
  } catch {
    return defaults
  }
}

/** Partial config patch accepted by the admin config writer. */
export interface AnalystConfigPatch {
  enabled?: boolean
  model?: string
  analysisPrompt?: string
  chatPrompt?: string
  suggestions?: string[]
  cacheTtlHours?: number
}

/**
 * Upsert the singleton analyst config. Service-role only (the route guards
 * super-admin). Returns the freshly-resolved config.
 */
export async function saveAnalystConfig(patch: AnalystConfigPatch, updatedBy: string): Promise<AnalystConfig> {
  const admin = createAdminClient()
  const update: Record<string, unknown> = {
    agent_key: AGENT_KEY,
    updated_by: updatedBy,
    updated_at: new Date().toISOString(),
  }
  if (patch.enabled !== undefined) update.enabled = patch.enabled
  if (patch.model !== undefined) update.model = coerceModel(patch.model)
  if (patch.analysisPrompt !== undefined) update.analysis_prompt = patch.analysisPrompt
  if (patch.chatPrompt !== undefined) update.chat_prompt = patch.chatPrompt
  if (patch.suggestions !== undefined) update.suggestions = coerceSuggestions(patch.suggestions)
  if (patch.cacheTtlHours !== undefined) {
    const n = Math.max(0, Math.min(8760, Math.round(patch.cacheTtlHours)))
    update.cache_ttl_hours = Number.isFinite(n) ? n : 24
  }

  await admin.from('markets_agent_config').upsert(update, { onConflict: 'agent_key' })
  return getAnalystConfig()
}

/**
 * Record a usage row (best-effort — never throws, so a logging failure can
 * never break a chat response).
 */
export async function recordAnalystUsage(params: {
  userId: string | null
  mode: 'analysis' | 'chat'
  model: string
  inputTokens: number
  outputTokens: number
}): Promise<void> {
  try {
    const admin = createAdminClient()
    await admin.from('markets_agent_usage').insert({
      user_id: params.userId,
      agent_key: AGENT_KEY,
      mode: params.mode,
      model: params.model,
      input_tokens: params.inputTokens,
      output_tokens: params.outputTokens,
      total_tokens: params.inputTokens + params.outputTokens,
    })
  } catch {
    /* best-effort — swallow */
  }
}

export interface AnalystUsageRollupRow {
  user_id: string | null
  email: string
  runs: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

/**
 * Roll up usage per user. Super-admin surface only — uses the admin client to
 * read the full ledger and enrich with email.
 */
export async function getAnalystUsageRollup(): Promise<AnalystUsageRollupRow[]> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('markets_agent_usage')
    .select('user_id, input_tokens, output_tokens, total_tokens')

  const rows = (data ?? []) as Array<{
    user_id: string | null
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }>

  const byUser = new Map<string, AnalystUsageRollupRow>()
  for (const r of rows) {
    const key = r.user_id ?? 'unknown'
    const existing = byUser.get(key)
    if (existing) {
      existing.runs += 1
      existing.input_tokens += r.input_tokens ?? 0
      existing.output_tokens += r.output_tokens ?? 0
      existing.total_tokens += r.total_tokens ?? 0
    } else {
      byUser.set(key, {
        user_id: r.user_id,
        email: '',
        runs: 1,
        input_tokens: r.input_tokens ?? 0,
        output_tokens: r.output_tokens ?? 0,
        total_tokens: r.total_tokens ?? 0,
      })
    }
  }

  // Enrich with email.
  try {
    const { data: { users } } = await admin.auth.admin.listUsers({ perPage: 1000 })
    const emailById = new Map((users ?? []).map(u => [u.id, u.email ?? '']))
    for (const row of Array.from(byUser.values())) {
      if (row.user_id) row.email = emailById.get(row.user_id) ?? ''
    }
  } catch {
    /* email enrichment is best-effort */
  }

  return Array.from(byUser.values()).sort((a, b) => b.total_tokens - a.total_tokens)
}
