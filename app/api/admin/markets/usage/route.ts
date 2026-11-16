import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMarketSettings } from '@/lib/markets/settings'

export const runtime = 'nodejs'

/**
 * Admin Markets usage API (MKT-8). Super-admin only. Backs the
 * /admin/markets/usage page: Market Analyst token usage rolled up by user, by
 * agent / view type, and as daily totals. Reads market_analyst_runs via the
 * service-role client; the super-admin check below is the real gate.
 */

async function verifySuperAdmin(userId: string): Promise<boolean> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('user_groups')
    .select('role')
    .eq('user_id', userId)
    .eq('role', 'super_admin')
  return (data?.length ?? 0) > 0
}

interface RunRow {
  user_id:     string | null
  tokens_used: number | null
  input:       unknown
  type:        string | null
  status:      string | null
  cached:      boolean | null
  created_at:  string
}

/** Discriminate the agent / view type from a run's input JSON. */
function viewTypeOf(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    if (typeof o.tool === 'string') return o.tool            // ranking | country | change_view
    if (typeof o.type === 'string') return o.type            // chat
  }
  return 'other'
}

// ─── GET /api/admin/markets/usage ─────────────────────────────────────────────
// Query params:
//   days  → window in days (default 30, max 365)
export async function GET(req: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!await verifySuperAdmin(session.user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const days = Math.min(365, Math.max(1, parseInt(searchParams.get('days') ?? '30', 10)))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  const admin = createAdminClient()
  const { data: runs, error } = await admin
    .from('market_analyst_runs')
    .select('user_id, tokens_used, input, type, status, cached, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (runs ?? []) as RunRow[]
  const settings = await getMarketSettings()

  // ── Roll up by user ──────────────────────────────────────────────────────
  const byUser = new Map<string, { user_id: string; tokens: number; runs: number; cachedRuns: number; errors: number; lastAt: string }>()
  // ── Roll up by view type (agent) ─────────────────────────────────────────
  const byType = new Map<string, { type: string; tokens: number; runs: number }>()
  // ── Roll up by day ───────────────────────────────────────────────────────
  const byDay = new Map<string, { day: string; tokens: number; runs: number }>()

  // Today's usage per user (UTC) for cap status.
  const startToday = new Date()
  startToday.setUTCHours(0, 0, 0, 0)
  const todayByUser = new Map<string, number>()

  for (const r of rows) {
    const tokens = r.tokens_used ?? 0
    const uid = r.user_id ?? 'unknown'

    const u = byUser.get(uid)
    if (u) {
      u.tokens += tokens
      u.runs += 1
      if (r.cached) u.cachedRuns += 1
      if (r.status === 'error') u.errors += 1
      if (r.created_at > u.lastAt) u.lastAt = r.created_at
    } else {
      byUser.set(uid, {
        user_id: uid,
        tokens,
        runs: 1,
        cachedRuns: r.cached ? 1 : 0,
        errors: r.status === 'error' ? 1 : 0,
        lastAt: r.created_at,
      })
    }

    const vt = viewTypeOf(r.input)
    const t = byType.get(vt)
    if (t) { t.tokens += tokens; t.runs += 1 }
    else byType.set(vt, { type: vt, tokens, runs: 1 })

    const day = r.created_at.slice(0, 10)
    const d = byDay.get(day)
    if (d) { d.tokens += tokens; d.runs += 1 }
    else byDay.set(day, { day, tokens, runs: 1 })

    if (new Date(r.created_at) >= startToday) {
      todayByUser.set(uid, (todayByUser.get(uid) ?? 0) + tokens)
    }
  }

  // Enrich user rows with emails.
  const userIds = Array.from(byUser.keys()).filter(id => id !== 'unknown')
  const emailById = new Map<string, string>()
  if (userIds.length > 0) {
    const { data: { users } } = await admin.auth.admin.listUsers({ perPage: 1000 })
    for (const u of users ?? []) emailById.set(u.id, u.email ?? u.id)
  }

  const cap = settings.dailyTokenCap
  const alertFloor = cap > 0 ? Math.floor((cap * settings.tokenAlertPercent) / 100) : 0

  const users = Array.from(byUser.values())
    .map(u => {
      const usedToday = todayByUser.get(u.user_id) ?? 0
      return {
        ...u,
        email: u.user_id === 'unknown' ? null : (emailById.get(u.user_id) ?? u.user_id),
        usedToday,
        overCap: cap > 0 && usedToday >= cap,
        approachingCap: cap > 0 && usedToday >= alertFloor && usedToday < cap,
      }
    })
    .sort((a, b) => b.tokens - a.tokens)

  const byTypeArr = Array.from(byType.values()).sort((a, b) => b.tokens - a.tokens)
  const daily = Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day))

  const totals = {
    tokens: rows.reduce((s, r) => s + (r.tokens_used ?? 0), 0),
    runs:   rows.length,
    users:  byUser.size,
  }

  return NextResponse.json({
    data: { users, byType: byTypeArr, daily, totals },
    settings: {
      dailyTokenCap:     settings.dailyTokenCap,
      tokenAlertPercent: settings.tokenAlertPercent,
    },
    window: { days },
  })
}
