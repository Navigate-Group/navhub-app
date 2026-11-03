import { NextResponse } from 'next/server'
import {
  requireMarketsViewer,
  logAnalystRun,
  cellAttribution,
} from '@/lib/markets/analyst'
import { buildCountryProfile } from '@/lib/markets/views'
import { getAnalystConfig } from '@/lib/markets/analyst-config'
import { buildCacheKey, getCache, setCache } from '@/lib/markets/analyst-cache'

export const runtime = 'nodejs'

/**
 * Market Analyst tool — Country profile (MKT-5).
 *
 *   POST /api/markets/analyst/country
 *   body: { iso3, commodity?, season?, valuation_method? }
 *
 * Returns the full country profile for the current view scope: all seven
 * measures (value + rank + fill flags + attribution), production by season,
 * sub-national regions, farm structure and operators. Every figure is tagged
 * with its season and derivation so the agent can cite it faithfully.
 *
 * Gated to Markets viewers; cached by the view parameters; logged to
 * market_analyst_runs.
 */
export async function POST(req: Request) {
  const started = Date.now()
  const ctx = await requireMarketsViewer()
  if ('error' in ctx) return ctx.error

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* ignore */ }

  const iso3 = typeof body.iso3 === 'string' ? body.iso3 : ''
  if (!iso3) {
    return NextResponse.json({ error: 'iso3 is required' }, { status: 400 })
  }
  const commodity = typeof body.commodity === 'string' ? body.commodity : 'banana'
  const season = typeof body.season === 'string' ? body.season : undefined
  const valuationMethod =
    typeof body.valuation_method === 'string' ? body.valuation_method : undefined

  const config = await getAnalystConfig()
  const cacheKey = buildCacheKey(
    {
      commodityId: commodity,
      seasonIds: season ? [season] : [],
      scope: iso3,
      valuationMethod,
    },
    'tool=country',
  )

  try {
    const hit = await getCache(cacheKey)
    if (hit) {
      await logAnalystRun({
        userId: ctx.userId,
        input: { tool: 'country', iso3, commodity, season, valuationMethod },
        output: JSON.stringify(hit).slice(0, 4000),
        tokensUsed: 0,
        durationMs: Date.now() - started,
        cached: true,
        status: 'success',
      })
      return NextResponse.json({ ...(hit as object), cached: true })
    }

    const profile = buildCountryProfile({
      commodity,
      iso3,
      season,
      valuationMethod,
    })
    if (!profile) {
      await logAnalystRun({
        userId: ctx.userId,
        input: { tool: 'country', iso3, commodity, season, valuationMethod },
        output: null,
        tokensUsed: 0,
        durationMs: Date.now() - started,
        cached: false,
        status: 'error',
      })
      return NextResponse.json({ error: `Unknown country '${iso3}'` }, { status: 404 })
    }

    // Tag every resolved measure with its season + derivation.
    const measures = profile.measures.map(m => ({
      ...m,
      attribution: m.value == null ? null : cellAttribution(profile.season, m.filled, m.filledFrom),
    }))

    const result = {
      iso3: profile.iso3,
      name: profile.name,
      continent: profile.continent,
      commodity: profile.commodity,
      commodityName: profile.commodityName,
      season: profile.season,
      seasons: profile.seasons,
      measures,
      productionBySeason: profile.productionBySeason.map(p => ({
        ...p,
        attribution: p.value == null ? null : cellAttribution(p.season, p.filled),
      })),
      regions: profile.regions,
      regionsGapSource: profile.regionsGapSource,
      structure: profile.structure,
      structureGapSource: profile.structureGapSource,
      operators: profile.operators,
      operatorsGapSource: profile.operatorsGapSource,
      disclaimer: profile.disclaimer,
    }

    await setCache(cacheKey, result, config.cacheTtlHours)
    await logAnalystRun({
      userId: ctx.userId,
      input: { tool: 'country', iso3, commodity, season, valuationMethod },
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
      input: { tool: 'country', iso3, commodity, season, valuationMethod },
      output: err instanceof Error ? err.message : String(err),
      tokensUsed: 0,
      durationMs: Date.now() - started,
      cached: false,
      status: 'error',
    })
    return NextResponse.json({ error: 'Failed to build country profile' }, { status: 500 })
  }
}
