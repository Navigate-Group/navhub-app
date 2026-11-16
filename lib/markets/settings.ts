/**
 * Markets global settings helpers (MKT-8) — server-side only.
 * ──────────────────────────────────────────────────────────────────────────
 * The admin-editable global configuration for the Markets explorer lives in the
 * singleton `market_settings` row (migration 078). A super admin edits it from
 * /admin/markets/settings; the explorer reads it at request time.
 *
 * Canonical DEFAULTS come from the bundled `markets_sample.json` (`config.*`) —
 * the same document the explorer and compute layer read today — so the settings
 * row matches the live explorer out of the box, before any override exists.
 *
 * ⚠️  SCOPE (MKT-8): this helper is the single request-time read point. MKT-8b
 *     will thread these settings through compute.ts/explorer.ts/views.ts to
 *     replace the direct reads from markets_sample.json. Until then, settings
 *     labelled "Saved; takes effect after MKT-8b" are persisted and surfaced
 *     here but not yet consumed by the compute core.
 *
 * An in-memory cache avoids re-reading the DB on every request; an explicit
 * invalidation on write makes a save take effect on the next page load with no
 * redeploy.
 *
 * ⚠️  Import only in server-side code. Reads/writes use the service-role admin
 *     client so settings are available regardless of the caller's RLS context
 *     (role gating happens at the route boundary).
 */

import sample from '../../markets_sample.json' with { type: 'json' }
import { createAdminClient } from '../supabase/admin'

// ── Canonical defaults & valid-option sets from the sample document ─────────

interface SampleCoverageDimension {
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
  coverage_dimensions?: SampleCoverageDimension[]
}

const CONFIG = (sample as { config?: SampleConfig }).config ?? {}
const MEASURES = (sample as { measures?: Record<string, unknown> }).measures ?? {}
const COMMODITIES = (sample as { commodities?: Record<string, { id: string; name: string }> }).commodities ?? {}

/** All measure ids defined in the sample (production, value, exports, …). */
export const ALL_MEASURE_IDS: string[] = Object.keys(MEASURES)

/** All commodity ids defined in the sample (banana, mango, …). */
export const ALL_COMMODITY_IDS: string[] = Object.keys(COMMODITIES)

/** All coverage-column labels defined in the sample's coverage_dimensions. */
export const ALL_COVERAGE_COLUMNS: string[] = (CONFIG.coverage_dimensions ?? []).map(d => d.label)

/** Default headline measures (from config.headline_measures). */
export const DEFAULT_HEADLINE_MEASURES: string[] =
  (CONFIG.headline_measures ?? ['production', 'value', 'exports', 'export_value']).slice()

/** Default ranking size (from config.ranking_size). */
export const DEFAULT_RANKING_SIZE = CONFIG.ranking_size ?? 10

/** Default default-commodity (from config.default_commodity). */
export const DEFAULT_COMMODITY = CONFIG.default_commodity ?? ALL_COMMODITY_IDS[0] ?? 'banana'

/** Default coverage columns — empty means "all". */
export const DEFAULT_COVERAGE_COLUMNS: string[] = []

/** Default daily per-user Market Analyst token cap. 0 = unlimited. */
export const DEFAULT_DAILY_TOKEN_CAP = 200_000

/** Default alert threshold (% of cap). */
export const DEFAULT_ALERT_THRESHOLD_PCT = 80

/** Default reset timezone (Perth has no DST). */
export const DEFAULT_RESET_TIMEZONE = 'Australia/Perth'

/** The allowed band for ranking size. */
export const RANKING_SIZE_MIN = 5
export const RANKING_SIZE_MAX = 20

// ── Resolved settings shape ─────────────────────────────────────────────────

export interface MarketSettings {
  headlineMeasures: string[]
  rankingSize: number
  coverageColumns: string[]
  defaultCommodity: string
  dailyTokenCap: number
  alertThresholdPct: number
  resetTimezone: string
  updatedAt: string | null
  updatedBy: string | null
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
  ranking_size: number | null
  coverage_columns: unknown
  default_commodity: string | null
  daily_token_cap: number | null
  alert_threshold_pct: number | null
  reset_timezone: string | null
  updated_at: string | null
  updated_by: string | null
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((s): s is string => typeof s === 'string')
}

function resolveRow(row: SettingsRow | null): MarketSettings {
  const headline = asStringArray(row?.headline_measures)
  const coverage = asStringArray(row?.coverage_columns)
  return {
    headlineMeasures:
      headline && headline.length > 0 ? headline : DEFAULT_HEADLINE_MEASURES.slice(),
    rankingSize:
      typeof row?.ranking_size === 'number' && row.ranking_size > 0
        ? row.ranking_size
        : DEFAULT_RANKING_SIZE,
    coverageColumns: coverage ?? DEFAULT_COVERAGE_COLUMNS.slice(),
    defaultCommodity: row?.default_commodity || DEFAULT_COMMODITY,
    dailyTokenCap:
      typeof row?.daily_token_cap === 'number' && row.daily_token_cap >= 0
        ? row.daily_token_cap
        : DEFAULT_DAILY_TOKEN_CAP,
    alertThresholdPct:
      typeof row?.alert_threshold_pct === 'number' && row.alert_threshold_pct >= 0
        ? row.alert_threshold_pct
        : DEFAULT_ALERT_THRESHOLD_PCT,
    resetTimezone: row?.reset_timezone || DEFAULT_RESET_TIMEZONE,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  }
}

/** The canonical default settings (used on any DB error). */
export function defaultMarketSettings(): MarketSettings {
  return resolveRow(null)
}

/**
 * Load the Markets global settings, merging DB overrides over the sample
 * defaults. Served from the in-memory cache when fresh. On any DB error the
 * safe defaults are returned (never throws) so the explorer degrades
 * gracefully.
 */
export async function getMarketSettings(): Promise<MarketSettings> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value

  let value: MarketSettings
  try {
    const admin = createAdminClient()
    const { data } = await admin
      .from('market_settings')
      .select(
        'headline_measures, ranking_size, coverage_columns, default_commodity, daily_token_cap, alert_threshold_pct, reset_timezone, updated_at, updated_by',
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

// ── Validation ──────────────────────────────────────────────────────────────

/** Fields an operator may update on the settings row. */
export interface MarketSettingsUpdate {
  headlineMeasures?: string[]
  rankingSize?: number
  coverageColumns?: string[]
  defaultCommodity?: string
  dailyTokenCap?: number
  alertThresholdPct?: number
  resetTimezone?: string
}

export interface ValidationResult {
  ok: boolean
  error?: string
}

/**
 * Validate a settings update against the known option sets:
 *   • every headline measure must be a defined measure id,
 *   • the default commodity must be a defined (active) commodity,
 *   • ranking size must be in the 5–20 band,
 *   • coverage columns must be defined coverage-dimension labels,
 *   • alert threshold must be 0–100, token cap must be ≥ 0.
 */
export function validateMarketSettings(update: MarketSettingsUpdate): ValidationResult {
  if (update.headlineMeasures !== undefined) {
    if (!Array.isArray(update.headlineMeasures) || update.headlineMeasures.length === 0) {
      return { ok: false, error: 'At least one headline measure is required.' }
    }
    const bad = update.headlineMeasures.find(m => !ALL_MEASURE_IDS.includes(m))
    if (bad) return { ok: false, error: `Unknown measure '${bad}'.` }
  }

  if (update.rankingSize !== undefined) {
    if (
      !Number.isInteger(update.rankingSize) ||
      update.rankingSize < RANKING_SIZE_MIN ||
      update.rankingSize > RANKING_SIZE_MAX
    ) {
      return {
        ok: false,
        error: `Ranking size must be between ${RANKING_SIZE_MIN} and ${RANKING_SIZE_MAX}.`,
      }
    }
  }

  if (update.coverageColumns !== undefined) {
    if (!Array.isArray(update.coverageColumns)) {
      return { ok: false, error: 'Coverage columns must be a list.' }
    }
    const bad = update.coverageColumns.find(c => !ALL_COVERAGE_COLUMNS.includes(c))
    if (bad) return { ok: false, error: `Unknown coverage column '${bad}'.` }
  }

  if (update.defaultCommodity !== undefined) {
    if (!ALL_COMMODITY_IDS.includes(update.defaultCommodity)) {
      return { ok: false, error: `Unknown or inactive commodity '${update.defaultCommodity}'.` }
    }
  }

  if (update.dailyTokenCap !== undefined) {
    if (!Number.isInteger(update.dailyTokenCap) || update.dailyTokenCap < 0) {
      return { ok: false, error: 'Daily token cap must be a non-negative whole number (0 = unlimited).' }
    }
  }

  if (update.alertThresholdPct !== undefined) {
    if (
      !Number.isInteger(update.alertThresholdPct) ||
      update.alertThresholdPct < 0 ||
      update.alertThresholdPct > 100
    ) {
      return { ok: false, error: 'Alert threshold must be between 0 and 100.' }
    }
  }

  return { ok: true }
}

/**
 * Persist settings changes to the singleton row and invalidate the in-memory
 * cache. Validates first — returns the validation error without writing when
 * invalid. Returns the freshly resolved settings on success. Uses the
 * service-role client so the admin surface owns writes; route-level role gating
 * (super admin) authorises the caller.
 */
export async function setMarketSettings(
  update: MarketSettingsUpdate,
  actorId: string | null,
): Promise<{ ok: true; settings: MarketSettings } | { ok: false; error: string }> {
  const valid = validateMarketSettings(update)
  if (!valid.ok) return { ok: false, error: valid.error ?? 'Invalid settings.' }

  const admin = createAdminClient()
  const patch: Record<string, unknown> = { id: 1, updated_at: new Date().toISOString(), updated_by: actorId }
  if (update.headlineMeasures !== undefined) patch.headline_measures = update.headlineMeasures
  if (update.rankingSize !== undefined) patch.ranking_size = update.rankingSize
  if (update.coverageColumns !== undefined) patch.coverage_columns = update.coverageColumns
  if (update.defaultCommodity !== undefined) patch.default_commodity = update.defaultCommodity
  if (update.dailyTokenCap !== undefined) patch.daily_token_cap = update.dailyTokenCap
  if (update.alertThresholdPct !== undefined) patch.alert_threshold_pct = update.alertThresholdPct
  if (update.resetTimezone !== undefined) patch.reset_timezone = update.resetTimezone

  const { error } = await admin.from('market_settings').upsert(patch, { onConflict: 'id' })
  if (error) return { ok: false, error: error.message }

  invalidateMarketSettingsCache()
  return { ok: true, settings: await getMarketSettings() }
}
