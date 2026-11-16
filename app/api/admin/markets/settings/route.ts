import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  getMarketSettings,
  setMarketSettings,
  type MarketSettingsUpdate,
} from '@/lib/markets/settings'
import sample from '@/markets_sample.json' with { type: 'json' }

export const runtime = 'nodejs'

/**
 * Admin Markets global settings API (MKT-8). Super-admin only. Backs the
 * /admin/markets/settings page: read and update the explorer's global display
 * configuration (headline measures & order, ranking measures, ranking size,
 * coverage columns & top-N, default commodity) and the per-user daily Market
 * Analyst token cap. Writes go through the service-role client; the super-admin
 * check below is the real gate (middleware also hard-403s /api/admin/*).
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

// The catalogue of measures / commodities the UI offers in its pickers, read
// from the same canonical sample document the explorer uses.
function catalogue() {
  const measuresObj = (sample as { measures?: Record<string, { label?: string; short?: string }> })
    .measures ?? {}
  const measures = Object.entries(measuresObj).map(([id, m]) => ({
    id,
    label: m?.label ?? id,
    short: m?.short ?? m?.label ?? id,
  }))
  const commoditiesObj = (sample as { commodities?: Record<string, { id?: string; name?: string }> })
    .commodities ?? {}
  const commodities = Object.values(commoditiesObj).map(c => ({
    id: c.id ?? '',
    name: c.name ?? c.id ?? '',
  }))
  return { measures, commodities }
}

// ─── GET /api/admin/markets/settings ──────────────────────────────────────────
export async function GET() {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!await verifySuperAdmin(session.user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const settings = await getMarketSettings()
  return NextResponse.json({ data: settings, catalogue: catalogue() })
}

// ─── PUT /api/admin/markets/settings ──────────────────────────────────────────
export async function PUT(req: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!await verifySuperAdmin(session.user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: Record<string, unknown>
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const update: MarketSettingsUpdate = {}

  if (Array.isArray(body.headlineMeasures)) {
    update.headlineMeasures = (body.headlineMeasures as unknown[]).filter(
      (s): s is string => typeof s === 'string',
    )
  }
  if (Array.isArray(body.rankingMeasures)) {
    update.rankingMeasures = (body.rankingMeasures as unknown[]).filter(
      (s): s is string => typeof s === 'string',
    )
  }
  if (Array.isArray(body.coverageDimensions)) {
    update.coverageDimensions = (body.coverageDimensions as unknown[]).filter(
      (d): d is { label: string; kind: string } =>
        !!d && typeof d === 'object' &&
        typeof (d as Record<string, unknown>).label === 'string' &&
        typeof (d as Record<string, unknown>).kind === 'string',
    ) as MarketSettingsUpdate['coverageDimensions']
  }

  if (body.rankingSize !== undefined) {
    const n = Number(body.rankingSize)
    if (!Number.isInteger(n) || n <= 0) {
      return NextResponse.json({ error: 'rankingSize must be a positive integer.' }, { status: 400 })
    }
    update.rankingSize = n
  }
  if (body.coverageTopN !== undefined) {
    const n = Number(body.coverageTopN)
    if (!Number.isInteger(n) || n <= 0) {
      return NextResponse.json({ error: 'coverageTopN must be a positive integer.' }, { status: 400 })
    }
    update.coverageTopN = n
  }
  if (body.defaultCommodity !== undefined) {
    update.defaultCommodity =
      typeof body.defaultCommodity === 'string' && body.defaultCommodity.trim().length > 0
        ? body.defaultCommodity.trim()
        : null
  }
  if (body.dailyTokenCap !== undefined) {
    const n = Number(body.dailyTokenCap)
    if (!Number.isInteger(n) || n < 0) {
      return NextResponse.json({ error: 'dailyTokenCap must be a non-negative integer (0 = unlimited).' }, { status: 400 })
    }
    update.dailyTokenCap = n
  }
  if (body.tokenAlertPercent !== undefined) {
    const n = Number(body.tokenAlertPercent)
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      return NextResponse.json({ error: 'tokenAlertPercent must be an integer between 0 and 100.' }, { status: 400 })
    }
    update.tokenAlertPercent = n
  }

  const settings = await setMarketSettings(update)

  // Record the change on the platform admin audit log (best-effort).
  void createAdminClient().from('admin_audit_log').insert({
    actor_id:    session.user.id,
    action:      'update_markets_settings',
    entity_type: 'markets',
    entity_id:   null,
    metadata:    update as Record<string, unknown>,
  })

  return NextResponse.json({ data: settings })
}
