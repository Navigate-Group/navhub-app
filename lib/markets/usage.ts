/**
 * Markets token-usage & cap-enforcement helpers (MKT-8) — server-side only.
 * ──────────────────────────────────────────────────────────────────────────
 * Two concerns:
 *
 *   1. CAP ENFORCEMENT — before the Market Analyst runs, a user's token total
 *      for the current day (reset at midnight in the configured timezone, Perth
 *      by default) is checked against the per-user daily cap from
 *      market_settings. Super admins are exempt (but their usage is still
 *      logged, elsewhere). Cached analyses do not count (they consume no
 *      tokens). One call overage is acceptable: the check is "already at/over
 *      the cap BEFORE this call", so a single call can push a user past the cap.
 *
 *   2. USAGE REPORTING — rollups of tokens by user and by agent (Market Analyst
 *      from market_analyst_runs, Document Extractor from markets_agent_runs) for
 *      the admin /admin/markets/usage page.
 *
 * Token sources:
 *   • Market Analyst     → market_analyst_runs (tokens_used, cached, user_id)
 *   • Document Extractor → markets_agent_runs  (tokens_used, user_id,
 *                          type='document_extractor')
 *
 * ⚠️  Import only in server-side code. Uses the service-role admin client.
 */

import { createAdminClient } from '../supabase/admin'
import { isPlatformSuperAdmin } from '../markets'
import { getMarketSettings } from './settings'
import type { SupabaseClient } from '@supabase/supabase-js'

// ── Day boundary in a given timezone ────────────────────────────────────────

/**
 * Return the UTC Date marking the start of "today" in the given IANA timezone.
 * Perth (Australia/Perth) has no DST, so this is a stable boundary. Falls back
 * to the UTC day start if the timezone is invalid.
 */
export function startOfDayInTimezone(timezone: string, now: Date = new Date()): Date {
  try {
    // Format `now` into the target timezone's wall-clock Y/M/D, then reconstruct
    // the instant that corresponds to that local midnight.
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(now)

    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
    const y = Number(get('year'))
    const mo = Number(get('month'))
    const d = Number(get('day'))
    const h = Number(get('hour') === '24' ? '0' : get('hour'))
    const mi = Number(get('minute'))
    const s = Number(get('second'))

    // The local wall-clock offset = (local time as if UTC) − (actual UTC now).
    const asUtc = Date.UTC(y, mo - 1, d, h, mi, s)
    const offsetMs = asUtc - (now.getTime() - (now.getTime() % 1000))
    // Local midnight as-if-UTC minus the offset gives the real UTC instant.
    const localMidnightAsUtc = Date.UTC(y, mo - 1, d, 0, 0, 0)
    return new Date(localMidnightAsUtc - offsetMs)
  } catch {
    const d = new Date(now)
    d.setUTCHours(0, 0, 0, 0)
    return d
  }
}

// ── Per-user daily Market Analyst token total ───────────────────────────────

/**
 * Sum a user's Market Analyst tokens since the start of the current day in the
 * configured timezone. Cached runs are excluded (cached = false) because they
 * consume no tokens and must not count against the cap.
 */
export async function getUserAnalystTokensToday(
  userId: string,
  timezone: string,
): Promise<number> {
  const admin = createAdminClient()
  const since = startOfDayInTimezone(timezone).toISOString()
  const { data } = await admin
    .from('market_analyst_runs')
    .select('tokens_used')
    .eq('user_id', userId)
    .eq('cached', false)
    .gte('created_at', since)
  const rows = (data ?? []) as Array<{ tokens_used: number | null }>
  return rows.reduce(
    (sum, r) => sum + (typeof r.tokens_used === 'number' ? r.tokens_used : 0),
    0,
  )
}

export interface CapCheck {
  /** True if the request may proceed. */
  allowed: boolean
  /** The user's token total used today (Market Analyst, non-cached). */
  usedToday: number
  /** The effective daily cap (0 = unlimited). */
  cap: number
  /** True when the caller is a super admin (exempt from the cap). */
  exempt: boolean
  /** A user-friendly message when the request is blocked. */
  message?: string
}

/** The user-facing message shown when a user has hit their daily cap. */
export const CAP_EXCEEDED_MESSAGE =
  "You've reached today's analysis limit. It resets at midnight (Perth time)."

/**
 * Decide whether a user may run the Market Analyst now. The check is evaluated
 * BEFORE the current call runs, against the user's already-accumulated total —
 * so a user at/over the cap is blocked, and one call of overage is tolerated
 * (the call that first reaches the cap is allowed, the next is not).
 *
 * Super admins are exempt (allowed regardless). A cap of 0 means unlimited.
 */
export async function checkAnalystCap(
  client: SupabaseClient,
  userId: string,
): Promise<CapCheck> {
  const settings = await getMarketSettings()
  const cap = settings.dailyTokenCap

  // Super admins are exempt (their usage is still logged by the run logger).
  const exempt = await isPlatformSuperAdmin(client, userId)
  if (exempt || cap <= 0) {
    return { allowed: true, usedToday: 0, cap, exempt }
  }

  const usedToday = await getUserAnalystTokensToday(userId, settings.resetTimezone)
  if (usedToday >= cap) {
    return {
      allowed: false,
      usedToday,
      cap,
      exempt: false,
      message: CAP_EXCEEDED_MESSAGE,
    }
  }
  return { allowed: true, usedToday, cap, exempt: false }
}

// ── Usage reporting (admin page) ────────────────────────────────────────────

export interface AgentUsageTotals {
  marketAnalystTokens: number
  marketAnalystRuns: number
  documentExtractorTokens: number
  documentExtractorRuns: number
}

export interface UserUsageRow {
  userId: string
  email: string
  marketAnalystTokens: number
  marketAnalystRuns: number
  documentExtractorTokens: number
  documentExtractorRuns: number
  totalTokens: number
  /** Non-cached Market Analyst tokens used today (for cap/alert display). */
  tokensToday: number
  /** True when today's usage has crossed the alert threshold. */
  overAlertThreshold: boolean
  /** True when today's usage is at/over the cap. */
  overCap: boolean
}

export interface UsageReport {
  totals: AgentUsageTotals
  users: UserUsageRow[]
  cap: number
  alertThresholdPct: number
  resetTimezone: string
  /** The number of users currently over the alert threshold. */
  alertingUsers: number
  /** The window (days) the all-time-ish totals cover; null = all time. */
  windowDays: number | null
}

interface AnalystRunRow {
  user_id: string | null
  tokens_used: number | null
  cached: boolean | null
  created_at: string
}

interface ExtractorRunRow {
  user_id: string | null
  tokens_used: number | null
  created_at: string
}

/**
 * Build the usage report for the admin page: tokens by user, by agent, and the
 * daily totals used to drive cap/alert display. `windowDays` restricts the
 * aggregate window (null = all time).
 */
export async function buildUsageReport(windowDays: number | null = 30): Promise<UsageReport> {
  const admin = createAdminClient()
  const settings = await getMarketSettings()
  const cap = settings.dailyTokenCap
  const alertThresholdPct = settings.alertThresholdPct
  const timezone = settings.resetTimezone

  const sinceWindow =
    windowDays && windowDays > 0
      ? new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString()
      : null
  const startToday = startOfDayInTimezone(timezone).toISOString()

  // Market Analyst runs
  let analystQ = admin
    .from('market_analyst_runs')
    .select('user_id, tokens_used, cached, created_at')
  if (sinceWindow) analystQ = analystQ.gte('created_at', sinceWindow)
  const { data: analystRows } = await analystQ

  // Document Extractor runs
  let extractorQ = admin
    .from('markets_agent_runs')
    .select('user_id, tokens_used, created_at')
    .eq('type', 'document_extractor')
  if (sinceWindow) extractorQ = extractorQ.gte('created_at', sinceWindow)
  const { data: extractorRows } = await extractorQ

  const analyst = (analystRows ?? []) as AnalystRunRow[]
  const extractor = (extractorRows ?? []) as ExtractorRunRow[]

  // Per-user accumulation
  const byUser = new Map<string, UserUsageRow>()
  const ensure = (userId: string): UserUsageRow => {
    let row = byUser.get(userId)
    if (!row) {
      row = {
        userId,
        email: '',
        marketAnalystTokens: 0,
        marketAnalystRuns: 0,
        documentExtractorTokens: 0,
        documentExtractorRuns: 0,
        totalTokens: 0,
        tokensToday: 0,
        overAlertThreshold: false,
        overCap: false,
      }
      byUser.set(userId, row)
    }
    return row
  }

  const totals: AgentUsageTotals = {
    marketAnalystTokens: 0,
    marketAnalystRuns: 0,
    documentExtractorTokens: 0,
    documentExtractorRuns: 0,
  }

  for (const r of analyst) {
    const tokens = typeof r.tokens_used === 'number' ? r.tokens_used : 0
    totals.marketAnalystTokens += tokens
    totals.marketAnalystRuns += 1
    if (!r.user_id) continue
    const row = ensure(r.user_id)
    row.marketAnalystTokens += tokens
    row.marketAnalystRuns += 1
    // Today's non-cached tokens drive the cap / alert display.
    if (r.cached !== true && r.created_at >= startToday) {
      row.tokensToday += tokens
    }
  }

  for (const r of extractor) {
    const tokens = typeof r.tokens_used === 'number' ? r.tokens_used : 0
    totals.documentExtractorTokens += tokens
    totals.documentExtractorRuns += 1
    if (!r.user_id) continue
    const row = ensure(r.user_id)
    row.documentExtractorTokens += tokens
    row.documentExtractorRuns += 1
  }

  // Resolve emails + finalise derived flags.
  const emailById = new Map<string, string>()
  try {
    const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
    for (const u of data?.users ?? []) emailById.set(u.id, u.email ?? '')
  } catch {
    /* best-effort — leave emails blank if the lookup fails */
  }

  const alertFloor = cap > 0 ? (cap * alertThresholdPct) / 100 : Infinity
  let alertingUsers = 0
  for (const row of byUser.values()) {
    row.email = emailById.get(row.userId) || row.userId
    row.totalTokens = row.marketAnalystTokens + row.documentExtractorTokens
    row.overCap = cap > 0 && row.tokensToday >= cap
    row.overAlertThreshold = cap > 0 && row.tokensToday >= alertFloor
    if (row.overAlertThreshold) alertingUsers += 1
  }

  const users = Array.from(byUser.values()).sort((a, b) => b.totalTokens - a.totalTokens)

  return {
    totals,
    users,
    cap,
    alertThresholdPct,
    resetTimezone: timezone,
    alertingUsers,
    windowDays,
  }
}
