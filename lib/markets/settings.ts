/**
 * Markets global settings & usage-cap helpers (MKT-8) — server-side only.
 * ──────────────────────────────────────────────────────────────────────────
 * The admin control surface for Markets lets a super admin tune the explorer's
 * GLOBAL display configuration (headline measures & their order, ranking
 * measures, ranking size, coverage columns & top-N, default commodity) and the
 * per-user daily Market Analyst token cap.
 *
 * These settings live in the SINGLETON `market_settings` row (migration 078).
 * Canonical DEFAULTS come from the bundled `markets_sample.json` (`config.*`) —
 * the same document the explorer and compute layer read — so the explorer works
 * out of the box before any admin override exists. The resolver merges any
 * stored override over those defaults.
 *
 * An in-memory cache avoids re-reading the DB on every request; the row rarely
 * changes, so a short TTL (plus explicit invalidation on write) is plenty.
 *
 * ⚠️  Import only in server-side code. Reads/writes use the service-role admin
 *     client so the settings are available regardless of the caller's RLS
 *     context; role gating happens at the route boundary (super-admin for
 *     writes, Markets viewer+ for the explorer read path).
 */

import sample from '../../markets_sample.json' with { type: 'json' }
import { createAdminClient } from '../supabase/admin'

// ── Canonical defaults from the sample document ─────────────────────────────

interface CoverageDimension {
  label: string
  kind: string
  measure?: string
  classification?: string
}

interface SampleConfig {
  ranking_size?: number
  coverage_top_n?: number
  default_commodity?: string
  headline_measures?: string[]
  ranking_measures?: string[]
  coverage_dimensions?: CoverageDimension[]
}

const SAMPLE_CONFIG = ((sample as { config?: SampleConfig }).config ?? {}) as SampleConfig

export const DEFAULT_HEADLINE_MEASURES: string[] = (SAMPLE_CONFIG.headline_measures ?? []).slice()
export const DEFAULT_RANKING_MEASURES: string[] = (SAMPLE_CONFIG.ranking_measures ?? []).slice()
export const DEFAULT_COVERAGE_DIMENSIONS: CoverageDimension[] =
  (SAMPLE_CONFIG.coverage_dimensions ?? []).slice()
export const DEFAULT_RANKING_SIZE = SAMPLE_CONFIG.ranking_size ?? 10
export const DEFAULT_COVERAGE_TOP_N = SAMPLE_CONFIG.coverage_top_n ?? 12
export const DEFAULT_COMMODITY = SAMPLE_CONFIG.default_commodity ?? ''

/** Daily token cap of 0 means "unlimited" (the shipped default). */
export const DEFAULT_DAILY_TOKEN_CAP = 0
export const DEFAULT_TOKEN_ALERT_PERCENT = 80

// ── Resolved settings shape ─────────────────────────────────────────────────

export interface MarketSettings {
  headlineMeasures: string[]
  rankingMeasures: string[]
  rankingSize: number
  coverageTopN: number
  coverageDimensions: CoverageDimension[]
  defaultCommodity: string
  /** Per-user daily Market Analyst token cap. 0 = unlimited. */
  dailyTokenCap: number
  /** Percent of the cap at which the admin UI flags a user (0–100). */
  tokenAlertPercent: number
}

// ── In-memory cache (avoid repeated DB reads) ───────────────────────────────

let cached: { value: MarketSettings; at: number } | null = null
const CACHE_MS = 60_000 // 1 minute — the row changes rarely.

/** Drop the in-memory settings cache (called after a write). */
export function invalidateMarketSettingsCache(): void {
  cached = null
}

interface SettingsRow {
  headline_measures: unknown
  ranking_measures: unknown
  ranking_size: number | null
  coverage_top_n: number | null
  coverage_dimensions: unknown
  default_commodity: string | null
  daily_token_cap: number | null
  token_alert_percent: number | null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((s): s is string => typeof s === 'string')
    : []
}

function asDimensionArray(value: unknown): CoverageDimension[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
    .filter(d => typeof d.label === 'string' && typeof d.kind === 'string')
    .map(d => ({
      label: d.label as string,
      kind: d.kind as string,
      ...(typeof d.measure === 'string' ? { measure: d.measure } : {}),
      ...(typeof d.classification === 'string' ? { classification: d.classification } : {}),
    }))
}

function resolveRow(row: SettingsRow | null): MarketSettings {
  const headline = asStringArray(row?.headline_measures)
  const ranking = asStringArray(row?.ranking_measures)
  const dimensions = asDimensionArray(row?.coverage_dimensions)
  return {
    headlineMeasures: headline.length > 0 ? headline : DEFAULT_HEADLINE_MEASURES.slice(),
    rankingMeasures: ranking.length > 0 ? ranking : DEFAULT_RANKING_MEASURES.slice(),
    rankingSize:
      typeof row?.ranking_size === 'number' && row.ranking_size > 0
        ? row.ranking_size
        : DEFAULT_RANKING_SIZE,
    coverageTopN:
      typeof row?.coverage_top_n === 'number' && row.coverage_top_n > 0
        ? row.coverage_top_n
        : DEFAULT_COVERAGE_TOP_N,
    coverageDimensions: dimensions.length > 0 ? dimensions : DEFAULT_COVERAGE_DIMENSIONS.slice(),
    defaultCommodity:
      (row?.default_commodity && row.default_commodity.trim().length > 0)
        ? row.default_commodity
        : DEFAULT_COMMODITY,
    dailyTokenCap:
      typeof row?.daily_token_cap === 'number' && row.daily_token_cap >= 0
        ? row.daily_token_cap
        : DEFAULT_DAILY_TOKEN_CAP,
    tokenAlertPercent:
      typeof row?.token_alert_percent === 'number' &&
      row.token_alert_percent >= 0 &&
      row.token_alert_percent <= 100
        ? row.token_alert_percent
        : DEFAULT_TOKEN_ALERT_PERCENT,
  }
}

/**
 * Load the global Markets settings, merging DB overrides over the sample
 * defaults. Served from the in-memory cache when fresh. On any DB error the
 * safe defaults are returned (never throws) so the explorer degrades gracefully.
 */
export async function getMarketSettings(): Promise<MarketSettings> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value

  let value: MarketSettings
  try {
    const admin = createAdminClient()
    const { data } = await admin
      .from('market_settings')
      .select(
        'headline_measures, ranking_measures, ranking_size, coverage_top_n, ' +
          'coverage_dimensions, default_commodity, daily_token_cap, token_alert_percent',
      )
      .eq('id', 1)
      .maybeSingle()
    value = resolveRow((data as SettingsRow | null) ?? null)
  } catch {
    value = resolveRow(null)
  }

  cached = { value, at: Date.now() }
  return value
}

/** Fields an operator may update on the settings row. */
export interface MarketSettingsUpdate {
  headlineMeasures?: string[]
  rankingMeasures?: string[]
  rankingSize?: number
  coverageTopN?: number
  coverageDimensions?: CoverageDimension[]
  defaultCommodity?: string | null
  dailyTokenCap?: number
  tokenAlertPercent?: number
}

/**
 * Persist settings changes to the singleton row and invalidate the in-memory
 * cache. Returns the freshly resolved settings. Uses the service-role client so
 * the admin surface owns writes; route-level super-admin gating authorises the
 * caller.
 */
export async function setMarketSettings(update: MarketSettingsUpdate): Promise<MarketSettings> {
  const admin = createAdminClient()
  const patch: Record<string, unknown> = { id: 1, updated_at: new Date().toISOString() }
  if (update.headlineMeasures !== undefined) patch.headline_measures = update.headlineMeasures
  if (update.rankingMeasures !== undefined) patch.ranking_measures = update.rankingMeasures
  if (update.rankingSize !== undefined) patch.ranking_size = update.rankingSize
  if (update.coverageTopN !== undefined) patch.coverage_top_n = update.coverageTopN
  if (update.coverageDimensions !== undefined) patch.coverage_dimensions = update.coverageDimensions
  if (update.defaultCommodity !== undefined) patch.default_commodity = update.defaultCommodity
  if (update.dailyTokenCap !== undefined) patch.daily_token_cap = update.dailyTokenCap
  if (update.tokenAlertPercent !== undefined) patch.token_alert_percent = update.tokenAlertPercent

  await admin.from('market_settings').upsert(patch, { onConflict: 'id' })
  invalidateMarketSettingsCache()
  return getMarketSettings()
}

// ── Usage-cap helpers ───────────────────────────────────────────────────────

/** The UTC start-of-day ISO timestamp used to scope "today's" token usage. */
export function startOfUtcDay(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  return d.toISOString()
}

/**
 * Sum a user's Market Analyst token usage since the start of the current UTC
 * day. Uses the service-role client (reads every run row). Returns 0 on error
 * so a transient read failure never wrongly blocks a user.
 */
export async function getUserDailyTokens(userId: string): Promise<number> {
  try {
    const admin = createAdminClient()
    const { data } = await admin
      .from('market_analyst_runs')
      .select('tokens_used')
      .eq('user_id', userId)
      .gte('created_at', startOfUtcDay())
    return (data ?? []).reduce(
      (sum: number, r: { tokens_used: number | null }) => sum + (r.tokens_used ?? 0),
      0,
    )
  } catch {
    return 0
  }
}

export interface CapStatus {
  cap: number
  used: number
  /** True when a cap is set (> 0) and today's usage has reached/exceeded it. */
  exceeded: boolean
}

/**
 * Resolve a user's daily cap status against the configured cap. A cap of 0 means
 * unlimited — never exceeded.
 */
export async function getUserCapStatus(userId: string): Promise<CapStatus> {
  const settings = await getMarketSettings()
  const cap = settings.dailyTokenCap
  const used = await getUserDailyTokens(userId)
  return { cap, used, exceeded: cap > 0 && used >= cap }
}
