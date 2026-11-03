/**
 * Market Analyst — deterministic fallback facts engine (MKT-5).
 * ──────────────────────────────────────────────────────────────────────────
 * When the Market Analyst agent is disabled by an operator, or a chat / analysis
 * run fails (timeout, rate-limit, missing key), the panel still shows something
 * useful: a short list of plain facts computed DIRECTLY from the figures already
 * on screen. These are never invented — every fact is derived from the
 * ExplorerView the Overview tab already built through the MKT-2 compute layer.
 *
 * Six templates are attempted, in order:
 *   1. Top share           — the leading country's share of the scope total.
 *   2. Exporter concentration — how concentrated exports are (top-3 share).
 *   3. Unit value range     — $/tonne implied by export value ÷ exports.
 *   4. Filled observations  — how many figures were forward-filled.
 *   5. Source diversity      — how many distinct sources back the view.
 *   6. Farm structure        — the dominant farm-structure band, when present.
 *
 * A template that cannot be computed from the data is OMITTED (never shown with
 * a placeholder). The module is pure, deterministic and dependency-free so it
 * runs identically in the browser and on the server.
 */

import type { ExplorerView, RankingList } from './explorer'

export interface FallbackFact {
  /** Stable template id (for keys / testing). */
  id:
    | 'top_share'
    | 'exporter_concentration'
    | 'unit_value_range'
    | 'filled_observations'
    | 'source_diversity'
    | 'farm_structure'
  /** Short label for the fact row. */
  label: string
  /** One-sentence computed statement (plain text). */
  text: string
}

/** Optional context the engine can use when it is available on screen. */
export interface FallbackContext {
  /** Human scope label ("World", "Asia", …). */
  scopeLabel?: string
  /** Distinct source short-labels backing the current view, if known. */
  sources?: string[]
  /** Dominant farm-structure band, if the view exposes one. */
  farmStructure?: { label: string; share: number } | null
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`
}

function compact(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function usd(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2, style: 'currency', currency: 'USD' }).format(value)
}

function ranking(view: ExplorerView, measure: RankingList['measure']): RankingList | undefined {
  return view.rankings.find(r => r.measure === measure)
}

/** 1. Top share — leading country's share of the scope total for production. */
function topShare(view: ExplorerView): FallbackFact | null {
  const prod = ranking(view, 'production') ?? view.rankings[0]
  const top = prod?.rows[0]
  if (!prod || !top || prod.total <= 0) return null
  const season = view.about.seasons[0] ?? ''
  return {
    id: 'top_share',
    label: 'Top share',
    text: `${top.name} leads ${prod.label.toLowerCase()} with ${pct(top.share)} of the scope total (${compact(top.value)} of ${compact(prod.total)}${season ? `, ${season}` : ''}).${top.filled ? ' Its figure was forward-filled from an earlier season.' : ''}`,
  }
}

/** 2. Exporter concentration — combined share of the top three exporters. */
function exporterConcentration(view: ExplorerView): FallbackFact | null {
  const exports = ranking(view, 'exports')
  if (!exports || exports.total <= 0 || exports.rows.length === 0) return null
  const topN = exports.rows.slice(0, 3)
  const combined = topN.reduce((s, r) => s + r.share, 0)
  const names = topN.map(r => r.name).join(', ')
  return {
    id: 'exporter_concentration',
    label: 'Exporter concentration',
    text: `The top ${topN.length} exporter${topN.length === 1 ? '' : 's'} (${names}) account for ${pct(combined)} of recorded exports — ${combined >= 0.6 ? 'a concentrated' : 'a comparatively spread'} market.`,
  }
}

/** 3. Unit value range — export value ÷ exported volume (implied $/tonne). */
function unitValueRange(view: ExplorerView): FallbackFact | null {
  const exports = ranking(view, 'exports')
  const exportValue = ranking(view, 'export_value')
  if (!exports || !exportValue) return null
  const units: number[] = []
  for (const row of exportValue.rows) {
    const vol = exports.rows.find(r => r.iso3 === row.iso3)
    if (vol && vol.value > 0) units.push(row.value / vol.value)
  }
  if (units.length < 2) return null
  const lo = Math.min(...units)
  const hi = Math.max(...units)
  return {
    id: 'unit_value_range',
    label: 'Unit value range',
    text: `Implied export unit value (derived from export value ÷ volume) ranges from ${usd(lo)} to ${usd(hi)} per tonne across ${units.length} exporters.`,
  }
}

/** 4. Filled observations — how many headline figures were forward-filled. */
function filledObservations(view: ExplorerView): FallbackFact | null {
  const filled = view.cards.reduce((s, c) => s + (c.filled ?? 0), 0)
  const counted = view.cards.reduce((s, c) => s + (c.counted ?? 0), 0)
  if (counted <= 0) return null
  if (filled === 0) {
    return {
      id: 'filled_observations',
      label: 'Filled observations',
      text: `None of the ${counted} contributing country figures on screen were forward-filled — all are reported for the selected season${view.about.seasons.length > 1 ? 's' : ''}.`,
    }
  }
  return {
    id: 'filled_observations',
    label: 'Filled observations',
    text: `${filled} of ${counted} contributing country figures were forward-filled from an earlier season — treat them as indicative, not current.`,
  }
}

/** 5. Source diversity — distinct sources backing the current view. */
function sourceDiversity(ctx: FallbackContext): FallbackFact | null {
  const sources = (ctx.sources ?? []).filter(Boolean)
  const unique = Array.from(new Set(sources))
  if (unique.length === 0) return null
  return {
    id: 'source_diversity',
    label: 'Source diversity',
    text: `This view draws on ${unique.length} distinct source${unique.length === 1 ? '' : 's'}: ${unique.slice(0, 4).join(', ')}${unique.length > 4 ? `, +${unique.length - 4} more` : ''}.`,
  }
}

/** 6. Farm structure — the dominant farm-structure band, when supplied. */
function farmStructure(ctx: FallbackContext): FallbackFact | null {
  const fs = ctx.farmStructure
  if (!fs || !(fs.share > 0)) return null
  return {
    id: 'farm_structure',
    label: 'Farm structure',
    text: `${pct(fs.share)} of holdings fall in the "${fs.label}" band — the dominant farm-structure class in this view.`,
  }
}

/**
 * Compute every fallback fact that the current view supports. Uncomputable
 * templates are omitted. Returns at most six facts, in template order.
 */
export function computeFallbackFacts(view: ExplorerView, ctx: FallbackContext = {}): FallbackFact[] {
  const candidates = [
    topShare(view),
    exporterConcentration(view),
    unitValueRange(view),
    filledObservations(view),
    sourceDiversity(ctx),
    farmStructure(ctx),
  ]
  return candidates.filter((f): f is FallbackFact => f != null)
}
