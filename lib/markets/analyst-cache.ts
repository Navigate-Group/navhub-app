/**
 * Market Analyst cache helpers (MKT-5) — server-side only.
 * ──────────────────────────────────────────────────────────────────────────
 * Memoises Market Analyst tool/chat results in `market_analyst_cache`
 * (migration 074). The cache key is built DETERMINISTICALLY from the view
 * parameters that actually change a figure — commodity, the (sorted) seasons,
 * combine mode, scope, valuation method and the gap-fill toggle — plus a
 * free-form suffix the caller adds (the tool name, the measure, the user's
 * question, etc.). Identical requests therefore collapse to one row.
 *
 * A row is "live" while `expires_at > now()`. The TTL is supplied by the caller
 * (from `market_analyst_config.cache_ttl_hours`).
 *
 * ⚠️  Import only in server-side code. Reads/writes use the service-role admin
 *     client; route-level role gating authorises the caller.
 */

import { createAdminClient } from '../supabase/admin'

/** The view parameters that determine a figure (the cache key dimensions). */
export interface CacheKeyParams {
  commodityId: string
  /** season ids — order-insensitive (sorted before hashing). */
  seasonIds: string[]
  /** 'total' | 'annual_average' (how multiple seasons combine). */
  combineMode?: string
  /** scope id — 'WORLD' | continent | zone. */
  scope?: string
  valuationMethod?: string
  fillGaps?: boolean
}

/**
 * Build a stable cache key. Seasons are sorted so ['2024','2020'] and
 * ['2020','2024'] hash identically. An optional `suffix` distinguishes
 * different questions over the same view (e.g. the tool name + its args, or the
 * normalised chat message). The parts are joined with '|' which cannot appear
 * in an iso id / measure / scope, keeping the key unambiguous.
 */
export function buildCacheKey(params: CacheKeyParams, suffix?: string): string {
  const seasons = [...params.seasonIds].sort().join(',')
  const parts = [
    `c=${params.commodityId}`,
    `s=${seasons}`,
    `m=${params.combineMode ?? 'total'}`,
    `sc=${params.scope ?? 'WORLD'}`,
    `v=${params.valuationMethod ?? ''}`,
    `f=${params.fillGaps ? '1' : '0'}`,
  ]
  if (suffix && suffix.length > 0) parts.push(`q=${suffix}`)
  return parts.join('|')
}

/**
 * Read a live cache entry. Returns the stored value (parsed JSON) or null when
 * absent or expired. Never throws — a cache miss on error is safe.
 */
export async function getCache<T = unknown>(key: string): Promise<T | null> {
  try {
    const admin = createAdminClient()
    const { data } = await admin
      .from('market_analyst_cache')
      .select('value, expires_at')
      .eq('key', key)
      .maybeSingle()
    if (!data) return null
    const row = data as { value: unknown; expires_at: string }
    if (new Date(row.expires_at).getTime() <= Date.now()) return null
    return row.value as T
  } catch {
    return null
  }
}

/**
 * Write (upsert) a cache entry with a TTL in hours. Never throws — a failed
 * cache write must not break the request that produced the value.
 */
export async function setCache(key: string, value: unknown, ttlHours: number): Promise<void> {
  try {
    const admin = createAdminClient()
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000).toISOString()
    await admin
      .from('market_analyst_cache')
      .upsert({ key, value, expires_at: expiresAt }, { onConflict: 'key' })
  } catch {
    /* ignore — caching is best-effort */
  }
}

/**
 * Delete all expired cache rows. Returns the number removed (best-effort; 0 on
 * error). Call from a maintenance route or cron.
 */
export async function cleanupExpiredCache(): Promise<number> {
  try {
    const admin = createAdminClient()
    const { data } = await admin
      .from('market_analyst_cache')
      .delete()
      .lt('expires_at', new Date().toISOString())
      .select('key')
    return data?.length ?? 0
  } catch {
    return 0
  }
}
