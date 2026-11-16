import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  getMarketSettings,
  setMarketSettings,
  ALL_MEASURE_IDS,
  ALL_COMMODITY_IDS,
  ALL_COVERAGE_COLUMNS,
  RANKING_SIZE_MIN,
  RANKING_SIZE_MAX,
  type MarketSettingsUpdate,
} from '@/lib/markets/settings'

export const runtime = 'nodejs'

/**
 * Admin Markets settings API (MKT-8). Super-admin only (also gated by
 * middleware + the admin layout; re-checked here for defence-in-depth). Reads
 * and writes the singleton market_settings row. On write, the settings helper
 * validates (measures exist, commodity is active, ranking size in range) and
 * invalidates the in-memory cache so changes take effect on the next page load
 * without a redeploy.
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

// ── GET /api/admin/markets/settings ──────────────────────────────────────────
// Returns the resolved settings plus the valid option sets the UI needs to
// render the editors (available measures, commodities, coverage columns).
export async function GET() {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!await verifySuperAdmin(session.user.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const settings = await getMarketSettings()
  return NextResponse.json({
    data: settings,
    options: {
      measures: ALL_MEASURE_IDS,
      commodities: ALL_COMMODITY_IDS,
      coverageColumns: ALL_COVERAGE_COLUMNS,
      rankingSizeMin: RANKING_SIZE_MIN,
      rankingSizeMax: RANKING_SIZE_MAX,
    },
  })
}

// ── PUT /api/admin/markets/settings ──────────────────────────────────────────
// Writes any subset of the settings. Validation happens in setMarketSettings;
// an invalid payload returns 400 with a human message and writes nothing.
export async function PUT(req: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!await verifySuperAdmin(session.user.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: Record<string, unknown>
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const update: MarketSettingsUpdate = {}
  if (Array.isArray(body.headlineMeasures)) {
    update.headlineMeasures = (body.headlineMeasures as unknown[]).filter((m): m is string => typeof m === 'string')
  }
  if (typeof body.rankingSize === 'number') update.rankingSize = body.rankingSize
  if (Array.isArray(body.coverageColumns)) {
    update.coverageColumns = (body.coverageColumns as unknown[]).filter((c): c is string => typeof c === 'string')
  }
  if (typeof body.defaultCommodity === 'string') update.defaultCommodity = body.defaultCommodity
  if (typeof body.dailyTokenCap === 'number') update.dailyTokenCap = body.dailyTokenCap
  if (typeof body.alertThresholdPct === 'number') update.alertThresholdPct = body.alertThresholdPct
  if (typeof body.resetTimezone === 'string') update.resetTimezone = body.resetTimezone

  const result = await setMarketSettings(update, session.user.id)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })

  // Record the change in the platform admin audit log for operator traceability.
  const admin = createAdminClient()
  void admin.from('admin_audit_log').insert({
    actor_id: session.user.id,
    action: 'update_markets_settings',
    entity_type: 'markets_settings',
    entity_id: '1',
    metadata: update as Record<string, unknown>,
  })

  return NextResponse.json({ data: result.settings })
}
