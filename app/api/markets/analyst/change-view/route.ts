import { NextResponse } from 'next/server'
import { requireMarketsViewer, logAnalystRun } from '@/lib/markets/analyst'
import {
  listCommodityOptions,
  getCommodityMeta,
  listScopeOptions,
  MAP_MEASURES,
  type ExplorerMeasure,
} from '@/lib/markets/explorer'

export const runtime = 'nodejs'

/**
 * Market Analyst tool — Change view (MKT-5).
 *
 *   POST /api/markets/analyst/change-view
 *   body: { commodity?, season?, scope?, map_measure? }
 *
 * Validates the requested controls against the available options and returns a
 * JSON INSTRUCTION the client applies to update the explorer controls. The
 * server does not mutate any state — it only confirms which controls are valid
 * and echoes back the normalised instruction. Gated to Markets viewers; logged
 * to market_analyst_runs. Not cached (it is a tiny validation, not a figure).
 */
export async function POST(req: Request) {
  const started = Date.now()
  const ctx = await requireMarketsViewer()
  if ('error' in ctx) return ctx.error

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* ignore */ }

  const commodities = new Set(listCommodityOptions().map(c => c.id))
  const scopes = new Set(listScopeOptions().map(s => s.id))

  const instruction: Record<string, unknown> = {}
  const rejected: Array<{ field: string; value: unknown; reason: string }> = []

  // commodity
  if (typeof body.commodity === 'string') {
    if (commodities.has(body.commodity)) instruction.commodity = body.commodity
    else rejected.push({ field: 'commodity', value: body.commodity, reason: 'unknown commodity' })
  }

  // season — validated against the (possibly newly-selected) commodity's seasons.
  if (typeof body.season === 'string') {
    const commodityForSeason =
      (instruction.commodity as string | undefined) ??
      (typeof body.commodity === 'string' ? body.commodity : undefined) ??
      listCommodityOptions()[0]?.id
    const meta = commodityForSeason ? getCommodityMeta(commodityForSeason) : null
    if (meta && meta.seasons.includes(body.season)) instruction.season = body.season
    else rejected.push({ field: 'season', value: body.season, reason: 'season not available for commodity' })
  }

  // scope
  if (typeof body.scope === 'string') {
    if (scopes.has(body.scope)) instruction.scope = body.scope
    else rejected.push({ field: 'scope', value: body.scope, reason: 'unknown scope' })
  }

  // map_measure
  if (typeof body.map_measure === 'string') {
    if (MAP_MEASURES.includes(body.map_measure as ExplorerMeasure)) {
      instruction.mapMeasure = body.map_measure
    } else {
      rejected.push({ field: 'map_measure', value: body.map_measure, reason: 'not a map measure' })
    }
  }

  const applied = Object.keys(instruction).length > 0
  const result = { action: 'change_view', instruction, applied, rejected }

  await logAnalystRun({
    userId: ctx.userId,
    input: { tool: 'change_view', body },
    output: JSON.stringify(result).slice(0, 2000),
    tokensUsed: 0,
    durationMs: Date.now() - started,
    cached: false,
    status: applied || rejected.length === 0 ? 'success' : 'error',
  })

  return NextResponse.json(result)
}
