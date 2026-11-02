/**
 * Markets calculation library (MKT-2).
 * ──────────────────────────────────────────────────────────────────────────
 * The single source of truth for every Markets figure. Both the UI components
 * (MKT-3) and the agent tools (MKT-5) call these functions so that the same
 * query always produces an identical number, source and season.
 *
 * Figures are computed from the canonical `markets_sample.json` — the same
 * document that migration 073 seeds into the database verbatim. Keeping the
 * compute layer and the seed loader reading the same shape guarantees the
 * backend and the seeded DB agree.
 *
 * Design notes:
 *  - Pure functions, no I/O, no DB client — deterministic and trivially
 *    testable (see lib/markets/compute.test.ts).
 *  - The JSON is imported directly; callers never pass data in. A future
 *    phase can swap the backing store for a DB query behind the same API
 *    without changing call sites.
 *  - `WLD` is the world aggregate. It is a valid `geo` in observations but is
 *    deliberately NOT a geo_unit, matching the seed.
 */

import sample from '../../markets_sample.json' with { type: 'json' }

// ── Source-shape types (mirror markets_sample.json) ─────────────────────────

export interface Observation {
  geo: string
  commodity: string
  measure: string
  season: string
  value: number
  source?: string
  confidence?: string
  note?: string
}

export interface Price {
  commodity: string
  series: string
  season: string
  value: number
  unit?: string
  source?: string
  note?: string
}

export interface FxRate {
  pair: string
  season: string
  rate: number
  source?: string
  note?: string
}

export interface GeoUnit {
  id: string
  name: string
  level: 'country' | 'region'
  m49?: string
  continent?: string
  zones?: string[]
  parent?: string
  region_type?: string
}

export interface ValuationMethod {
  id: string
  label: string
  price_series?: string
  price_measure?: string
  description?: string
  caveat?: string
}

export interface StructureEntry {
  note?: string
  classifications?: Record<string, [string, string]>
  breakdowns?: Array<{ label: string; parts: Array<{ label: string; share: number }> }>
  sources?: string[]
}

export interface Operator {
  name: string
  country?: string
  region?: string
  ownership?: string
  role?: string
  size?: string
  status?: string
  source?: string | null
}

export interface GapSources {
  regions?: string
  operators?: string
  structure?: string
  [k: string]: string | undefined
}

interface Commodity {
  id: string
  name: string
  seasons: string[]
  default_season?: string
  default_country?: string
  valuation_methods: ValuationMethod[]
  structure: Record<string, StructureEntry>
  gap_sources: Record<string, GapSources>
  operators: Operator[]
  [k: string]: unknown
}

// ── Backing data (typed views onto the sample document) ─────────────────────

const OBSERVATIONS = sample.observations as Observation[]
const PRICES = sample.prices as Price[]
const FX = sample.fx as FxRate[]
const GEO = sample.geo as GeoUnit[]
const COMMODITIES = sample.commodities as unknown as Record<string, Commodity>

/** The world aggregate geo id (not a geo_unit, only an observation key). */
export const WORLD = 'WLD'

// ── Query argument shapes ───────────────────────────────────────────────────

export interface HeadlineQuery {
  commodity: string
  year: string
  /** geo id; defaults to the world aggregate 'WLD'. */
  geography?: string
}

/** A resolved figure: the value plus where it came from. */
export interface Figure {
  value: number
  source?: string
  confidence?: string
  season: string
  /** true when the value was forward-filled from an earlier season. */
  filled: boolean
  /** the season the value was actually reported for, if filled. */
  filledFrom?: string
  note?: string
}

// ── Internal helpers ────────────────────────────────────────────────────────

function findObservation(
  commodity: string,
  measure: string,
  season: string,
  geography: string,
): Observation | undefined {
  return OBSERVATIONS.find(
    o =>
      o.commodity === commodity &&
      o.measure === measure &&
      o.season === season &&
      o.geo === geography,
  )
}

/** Seasons for a commodity, oldest → newest (the order they appear in source). */
function commoditySeasons(commodity: string): string[] {
  const c = COMMODITIES[commodity]
  return c ? c.seasons.slice() : []
}

/**
 * Look up a raw observation with optional forward-fill: if the exact season
 * is missing, fall back to the most recent EARLIER season that has a value
 * for this commodity/geo/measure. The returned Figure records whether it was
 * filled and from which season.
 */
function lookupMeasure(
  commodity: string,
  measure: string,
  season: string,
  geography: string,
  { fill = false }: { fill?: boolean } = {},
): Figure | null {
  const exact = findObservation(commodity, measure, season, geography)
  if (exact) {
    return {
      value: exact.value,
      source: exact.source,
      confidence: exact.confidence,
      season,
      filled: false,
      note: exact.note,
    }
  }
  if (!fill) return null

  // Forward-fill: walk earlier seasons (by the commodity's declared order).
  const seasons = commoditySeasons(commodity)
  const idx = seasons.indexOf(season)
  const earlier = idx >= 0 ? seasons.slice(0, idx).reverse() : []
  for (const s of earlier) {
    const prev = findObservation(commodity, measure, s, geography)
    if (prev) {
      return {
        value: prev.value,
        source: prev.source,
        confidence: prev.confidence,
        season,
        filled: true,
        filledFrom: s,
        note: prev.note,
      }
    }
  }
  return null
}

// ── Headline lookups ────────────────────────────────────────────────────────

/** Production (tonnes) for a commodity/season/geography. */
export function getProduction(q: HeadlineQuery): Figure | null {
  return lookupMeasure(q.commodity, 'production', q.year, q.geography ?? WORLD)
}

/** Export volume (tonnes). */
export function getExports(q: HeadlineQuery): Figure | null {
  return lookupMeasure(q.commodity, 'exports', q.year, q.geography ?? WORLD)
}

/** Export value (USD, reported trade value). */
export function getExportValue(q: HeadlineQuery): Figure | null {
  return lookupMeasure(q.commodity, 'export_value', q.year, q.geography ?? WORLD)
}

/** Area harvested (hectares). */
export function getAreaHarvested(q: HeadlineQuery): Figure | null {
  return lookupMeasure(q.commodity, 'area_harvested', q.year, q.geography ?? WORLD)
}

/** Reported export unit count (boxes) where present. */
export function getExportsBoxes(q: HeadlineQuery): Figure | null {
  return lookupMeasure(q.commodity, 'exports_boxes', q.year, q.geography ?? WORLD)
}

// ── Gap-filled lookups ──────────────────────────────────────────────────────

/**
 * Production with forward-fill. When the exact season is missing, the most
 * recent earlier season is used and the result is flagged `filled`. Validates
 * the gap-filling logic the UI uses to avoid blank cells.
 */
export function getProductionFilled(q: HeadlineQuery): Figure | null {
  return lookupMeasure(q.commodity, 'production', q.year, q.geography ?? WORLD, {
    fill: true,
  })
}

/** Generic forward-filled measure lookup. */
export function getMeasureFilled(
  commodity: string,
  measure: string,
  year: string,
  geography: string = WORLD,
): Figure | null {
  return lookupMeasure(commodity, measure, year, geography, { fill: true })
}

/**
 * The fallback source text for a gap in a given dimension
 * ('regions' | 'operators' | 'structure') for a commodity/geography, using
 * the commodity's `gap_sources` map with the `_default` fallback.
 */
export function getGapSource(
  commodity: string,
  geography: string,
  dimension: 'regions' | 'operators' | 'structure',
): string | null {
  const c = COMMODITIES[commodity]
  if (!c) return null
  const perGeo = c.gap_sources[geography]
  if (perGeo && perGeo[dimension]) return perGeo[dimension] as string
  const dflt = c.gap_sources._default
  if (dflt && dflt[dimension]) return dflt[dimension] as string
  // Fall back to the document-wide default where the commodity omits _default.
  const globalDefault = (sample as { gap_default?: GapSources }).gap_default
  if (globalDefault && globalDefault[dimension]) return globalDefault[dimension] as string
  return null
}

// ── Price lookups & valuation ───────────────────────────────────────────────

/** A price-series value for a commodity/series/season. */
export function getPrice(
  commodity: string,
  series: string,
  season: string,
): Price | null {
  return (
    PRICES.find(
      p => p.commodity === commodity && p.series === series && p.season === season,
    ) ?? null
  )
}

/** The USD fx rate for a pair in a season (e.g. 'USD per AUD'). */
export function getFxRate(pair: string, season: string): FxRate | null {
  return FX.find(f => f.pair === pair && f.season === season) ?? null
}

/** The producer (farm-gate) price observation for a geo/season, if present. */
export function getProducerPrice(
  commodity: string,
  season: string,
  geography: string,
): Observation | null {
  return findObservation(commodity, 'producer_price', season, geography) ?? null
}

export interface ValuationResult {
  value: number
  method: string
  /** the per-tonne price applied. */
  price: number
  priceSource?: string
  productionSeason: string
  productionFilled: boolean
}

/**
 * Production value using the GLOBAL method: production × a price series value
 * for the season. Returns null if production or the price is unavailable.
 */
export function getValueGlobal(
  commodity: string,
  series: string,
  year: string,
  geography: string = WORLD,
): ValuationResult | null {
  const prod = getProductionFilled({ commodity, year, geography })
  const price = getPrice(commodity, series, year)
  if (!prod || !price) return null
  return {
    value: prod.value * price.value,
    method: 'global',
    price: price.value,
    priceSource: price.source,
    productionSeason: year,
    productionFilled: prod.filled,
  }
}

/**
 * Production value using the LOCAL method: production × the geography's own
 * producer (farm-gate) price for the season. Returns null if production or the
 * producer price is unavailable.
 */
export function getValueLocal(
  commodity: string,
  year: string,
  geography: string,
): ValuationResult | null {
  const prod = getProductionFilled({ commodity, year, geography })
  const pp = getProducerPrice(commodity, year, geography)
  if (!prod || !pp) return null
  return {
    value: prod.value * pp.value,
    method: 'local',
    price: pp.value,
    priceSource: pp.source,
    productionSeason: year,
    productionFilled: prod.filled,
  }
}

// ── Ratio measures ──────────────────────────────────────────────────────────

export interface RatioResult {
  value: number
  numerator: number
  denominator: number
  season: string
}

/** Yield = production ÷ area_harvested (t/ha). */
export function getYield(q: HeadlineQuery): RatioResult | null {
  const geography = q.geography ?? WORLD
  const prod = findObservation(q.commodity, 'production', q.year, geography)
  const area = findObservation(q.commodity, 'area_harvested', q.year, geography)
  if (!prod || !area || area.value === 0) return null
  return {
    value: prod.value / area.value,
    numerator: prod.value,
    denominator: area.value,
    season: q.year,
  }
}

/** Export share = exports ÷ production (fraction 0–1; ×100 for a percentage). */
export function getExportShare(q: HeadlineQuery): RatioResult | null {
  const geography = q.geography ?? WORLD
  const exp = findObservation(q.commodity, 'exports', q.year, geography)
  const prod = findObservation(q.commodity, 'production', q.year, geography)
  if (!exp || !prod || prod.value === 0) return null
  return {
    value: exp.value / prod.value,
    numerator: exp.value,
    denominator: prod.value,
    season: q.year,
  }
}

// ── Farm structure & operators ──────────────────────────────────────────────

/** Farm structure (classifications, breakdowns, sources) for a commodity/geo. */
export function getStructure(
  commodity: string,
  geography: string,
): StructureEntry | null {
  const c = COMMODITIES[commodity]
  if (!c) return null
  return c.structure[geography] ?? null
}

/** All named operators for a commodity (optionally filtered by country). */
export function getOperators(commodity: string, country?: string): Operator[] {
  const c = COMMODITIES[commodity]
  if (!c) return []
  const ops = c.operators ?? []
  return country ? ops.filter(o => o.country === country) : ops.slice()
}

// ── Reference lookups ───────────────────────────────────────────────────────

/** A geo_unit by id (returns null for the 'WLD' aggregate — not a geo_unit). */
export function getGeoUnit(id: string): GeoUnit | null {
  return GEO.find(g => g.id === id) ?? null
}

/** The sub-national regions of a country. */
export function getRegions(countryId: string): GeoUnit[] {
  return GEO.filter(g => g.level === 'region' && g.parent === countryId)
}

/** The valuation methods declared for a commodity. */
export function getValuationMethods(commodity: string): ValuationMethod[] {
  const c = COMMODITIES[commodity]
  return c ? c.valuation_methods.slice() : []
}

/** List of commodity ids in declared order. */
export function listCommodities(): string[] {
  return Object.keys(COMMODITIES)
}
