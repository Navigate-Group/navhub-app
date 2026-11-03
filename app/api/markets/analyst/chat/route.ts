import { NextResponse } from 'next/server'
import {
  requireMarketsViewer,
  logAnalystRun,
  callClaudeStream,
  AnalystRateLimitError,
  AnalystTimeoutError,
  cellAttribution,
} from '@/lib/markets/analyst'
import { getAnalystConfig } from '@/lib/markets/analyst-config'
import {
  buildExplorerView,
  getDefaultCommodity,
  getCommodityMeta,
  RANKING_MEASURES,
  type ExplorerMeasure,
  type ExplorerParams,
} from '@/lib/markets/explorer'

export const runtime = 'nodejs'

/**
 * Market Analyst — streaming chat (MKT-5).
 *
 *   POST /api/markets/analyst/chat
 *   body: { message, view?: { commodity, seasons, scope, mapMeasure,
 *           valuationMethod, fillGaps, combineMode } }
 *
 * Builds the current-view context (headline cards + rankings, every figure
 * tagged with its season and derivation), calls Claude with the configured
 * model + prompt, streams the response text to the client chunk-by-chunk, counts
 * tokens from the Anthropic response metadata and logs the run to
 * market_analyst_runs. Timeout / rate-limit errors are caught, logged with
 * status='error', and surfaced to the client — never silently swallowed.
 *
 * Gated to Markets viewers.
 */

interface ViewContext {
  commodity: string
  commodityName: string
  seasons: string[]
  scope: string
  mapMeasure: ExplorerMeasure
  valuationMethod: string
  fillGaps: boolean
  combineMode: string
  disclaimer: string
  headlines: Array<{
    measure: string
    label: string
    unit: string
    value: number | null
    worldValue: number | null
    shareOfWorld: number | null
    attribution: string
  }>
  rankings: Array<{
    measure: string
    label: string
    unit: string
    total: number
    top: Array<{
      rank: number
      iso3: string
      name: string
      value: number
      share: number
      attribution: string
    }>
  }>
}

/** Build the attributed view context the model answers from. */
function buildViewContext(view: Record<string, unknown>): ViewContext {
  const commodity =
    typeof view.commodity === 'string' ? view.commodity : getDefaultCommodity()
  const meta = getCommodityMeta(commodity)
  const seasons = Array.isArray(view.seasons)
    ? (view.seasons as unknown[]).filter((s): s is string => typeof s === 'string')
    : meta
      ? [meta.defaultSeason]
      : []
  const scope = typeof view.scope === 'string' ? view.scope : 'WORLD'
  const mapMeasure =
    typeof view.mapMeasure === 'string' && RANKING_MEASURES.includes(view.mapMeasure as ExplorerMeasure)
      ? (view.mapMeasure as ExplorerMeasure)
      : 'production'
  const valuationMethod =
    typeof view.valuationMethod === 'string' ? view.valuationMethod : ''
  const fillGaps = view.fillGaps === undefined ? true : Boolean(view.fillGaps)
  const combineMode = typeof view.combineMode === 'string' ? view.combineMode : 'total'

  const params: ExplorerParams = {
    commodity,
    seasons,
    annualAverage: combineMode === 'annual_average',
    valuationMethod,
    fillGaps,
    scope,
    mapMeasure,
  }
  const explorer = buildExplorerView(params)
  const seasonLabel = seasons.join(', ')

  return {
    commodity,
    commodityName: explorer.about.commodityName,
    seasons,
    scope,
    mapMeasure,
    valuationMethod,
    fillGaps,
    combineMode,
    disclaimer: explorer.about.disclaimer,
    headlines: explorer.cards.map(c => ({
      measure: c.measure,
      label: c.label,
      unit: c.unit,
      value: c.value,
      worldValue: c.worldValue,
      shareOfWorld: c.shareOfWorld,
      attribution: c.value == null ? 'no figure' : cellAttribution(seasonLabel, c.filled > 0),
    })),
    rankings: explorer.rankings.map(r => ({
      measure: r.measure,
      label: r.label,
      unit: r.unit,
      total: r.total,
      top: r.rows.map(row => ({
        rank: row.rank,
        iso3: row.iso3,
        name: row.name,
        value: row.value,
        share: row.share,
        attribution: cellAttribution(seasonLabel, row.filled, row.filledFrom),
      })),
    })),
  }
}

export async function POST(req: Request) {
  const started = Date.now()
  const ctx = await requireMarketsViewer()
  if ('error' in ctx) return ctx.error

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* ignore */ }

  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 })
  }
  const view = (body.view && typeof body.view === 'object') ? (body.view as Record<string, unknown>) : {}

  const config = await getAnalystConfig()
  if (!config.enabled) {
    return NextResponse.json({ error: 'The Market Analyst is currently disabled' }, { status: 503 })
  }

  const viewContext = buildViewContext(view)

  // The user message handed to the model: the current view (with attributed
  // figures) followed by the question. The system prompt (config.prompt) tells
  // the model to answer only from this data and quote figures with their season.
  const userMessage =
    `Current market view (answer ONLY from this data; every figure is tagged ` +
    `with its season and whether it was forward-filled):\n` +
    `${JSON.stringify(viewContext, null, 2)}\n\n` +
    `User question: ${message}`

  const encoder = new TextEncoder()
  let fullText = ''
  let tokens = 0

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const result = await callClaudeStream({
          model: config.model,
          system: config.prompt,
          userMessage,
          maxTokens: 1_500,
          onChunk: chunk => {
            controller.enqueue(encoder.encode(chunk))
          },
        })
        fullText = result.text
        tokens = result.tokens
        controller.close()

        await logAnalystRun({
          userId: ctx.userId,
          input: { type: 'chat', message, view: viewContext },
          output: fullText,
          tokensUsed: tokens,
          durationMs: Date.now() - started,
          cached: false,
          status: 'success',
        })
      } catch (err) {
        // Surface the error to the client in-stream (never silent), and log it.
        let clientMsg: string
        if (err instanceof AnalystRateLimitError) {
          clientMsg = `\n\n[error] The analyst is rate-limited. Please retry in ${err.retryAfter}s.`
        } else if (err instanceof AnalystTimeoutError) {
          clientMsg = `\n\n[error] The analyst request timed out. Please try again.`
        } else {
          clientMsg = `\n\n[error] The analyst could not complete this request.`
        }
        try { controller.enqueue(encoder.encode(clientMsg)) } catch { /* ignore */ }
        try { controller.close() } catch { /* ignore */ }

        await logAnalystRun({
          userId: ctx.userId,
          input: { type: 'chat', message, view: viewContext },
          output: err instanceof Error ? err.message : String(err),
          tokensUsed: tokens,
          durationMs: Date.now() - started,
          cached: false,
          status: 'error',
        })
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}
