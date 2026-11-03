import { NextResponse } from 'next/server'
import {
  requireMarketsViewer,
  logAnalystRun,
  cellAttribution,
} from '@/lib/markets/analyst'
import {
  buildFullRanking,
  RANKING_MEASURES,
  getDefaultCommodity,
  getCommodityMeta,
  type ExplorerMeasure,
} from '@/lib/markets/explorer'
import { getAnalystConfig } from '@/lib/markets/analyst-config'
import { buildCacheKey, getCache, setCache } from '@/lib/markets/analyst-cache'

export const runtime = 'nodejs'

/**
 * Market Analyst tool — Ranking (MKT-5).
 *
 *   POST /api/markets/analyst/ranking
 *   body: { measure, commodity?, seasons?, scope?, valuation_method?,
 *           fill_gaps?, combine_mode? }
 *
 * Returns ALL producing countries in scope ranked by the requested measure —
 * rank, value, share, fill flags and attribution for every row (not the UI's
 * top-N slice). Gated to Markets viewers; cached by the view parameters; logged
 * to market_analyst_runs.
 */
export async function POST(req: Request) {
  const started = Date.now()
  const ctx = await requireMarketsViewer()
  if ('error' in ctx) return ctx.error

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* ignore */ }

  const measure = typeof body.measure === 'string' ? (body.measure as ExplorerMeasure) : undefined
  if (!measure || !RANKING_MEASURES.includes(measure)) {
    return NextResponse.json(
      { error: `measure is required; one of ${RANKING_MEASURES.join(', ')}` },
      { status: 400 },
    )
  }

  const commodity = typeof body.commodity === 'string' ? body.commodity : getDefaultCommodity()
  const meta = getCommodityMeta(commodity)
  const seasons = Array.isArray(body.seasons)
    ? (body.seasons as unknown[]).filter((s): s is string => typeof s === 'string')
    : meta
      ? [meta.defaultSeason]
      : []
  const scope = typeof body.scope === 'string' ? body.scope : 'WORLD'
  const valuationMethod =
    typeof body.valuation_method === 'string' ? body.valuation_method : ''
  const fillGaps = body.fill_gaps === undefined ? true : Boolean(body.fill_gaps)
  const combineMode =
    typeof body.combine_mode === 'string' ? body.combine_mode : 'total'
  const annualAverage = combineMode === 'annual_average'

  const config = await getAnalystConfig()
  const cacheKey = buildCacheKey(
    {
      commodityId: commodity,
      seasonIds: seasons,
      combineMode,
      scope,
      valuationMethod,
      fillGaps,
    },
    `tool=ranking:${measure}`,
  )

  try {
    const hit = await getCache(cacheKey)
    if (hit) {
      await logAnalystRun({
        userId: ctx.userId,
        input: { tool: 'ranking', measure, commodity, seasons, scope, combineMode, fillGaps },
        output: JSON.stringify(hit).slice(0, 4000),
        tokensUsed: 0,
        durationMs: Date.now() - started,
        cached: true,
        status: 'success',
      })
      return NextResponse.json({ ...(hit as object), cached: true })
    }

    const ranking = buildFullRanking(
      {
        commodity,
        seasons,
        annualAverage,
        valuationMethod,
        fillGaps,
        scope,
        mapMeasure: measure,
      },
      measure,
    )

    const result = {
      measure: ranking.measure,
      label: ranking.label,
      unit: ranking.unit,
      format: ranking.format,
      commodity,
      commodityName: meta?.name ?? commodity,
      seasons,
      scope,
      combineMode,
      total: ranking.total,
      rankedCount: ranking.rankedCount,
      missingCount: ranking.missingCount,
      noPriceCount: ranking.noPriceCount,
      rows: ranking.rows.map(r => ({
        ...r,
        attribution: cellAttribution(seasons.join(', '), r.filled, r.filledFrom),
      })),
    }

    await setCache(cacheKey, result, config.cacheTtlHours)
    await logAnalystRun({
      userId: ctx.userId,
      input: { tool: 'ranking', measure, commodity, seasons, scope, combineMode, fillGaps },
      output: JSON.stringify(result).slice(0, 4000),
      tokensUsed: 0,
      durationMs: Date.now() - started,
      cached: false,
      status: 'success',
    })
    return NextResponse.json({ ...result, cached: false })
  } catch (err) {
    await logAnalystRun({
      userId: ctx.userId,
      input: { tool: 'ranking', measure, commodity, seasons, scope, combineMode, fillGaps },
      output: err instanceof Error ? err.message : String(err),
      tokensUsed: 0,
      durationMs: Date.now() - started,
      cached: false,
      status: 'error',
    })
    return NextResponse.json({ error: 'Failed to build ranking' }, { status: 500 })
  }
}
