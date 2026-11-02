/**
 * Markets Explorer view model (MKT-3).
 * ──────────────────────────────────────────────────────────────────────────
 * Turns the MKT-2 compute primitives (lib/markets/compute.ts) and the canonical
 * markets_sample.json into the aggregated, scope-aware shape the `/markets`
 * Overview tab renders: headline cards, a choropleth keyed by M49, and the
 * top-10 rankings. Every figure still flows through the compute layer, so the
 * UI and the agent tools can never disagree about a number.
 *
 * Design notes:
 *  - Pure, deterministic, no I/O — safe to run on the server (initial render)
 *    OR in the browser (control changes recompute instantly). The JSON is
 *    bundled the same way compute.ts bundles it.
 *  - The explorer never invents numbers. Missing data becomes an explicit
 *    `no-data` state; forward-filled figures carry the season they came from.
 */

import sample from '../../markets_sample.json' with { type: 'json' }
import {
  WORLD,
  getMeasureFilled,
  getValuationMethods,
  getPrice,
  getProducerPrice,
  type ValuationMethod,
  type GeoUnit,
} from './compute'

// ── Source-shape slices (read-only views on the sample) ─────────────────────

interface SampleObservation {
  geo: string
  commodity: string
  measure: string
  season: string
  value: number
  source?: string
  confidence?: string
  note?: string
}

interface SampleCommodity {
  id: string
  name: string
  codes?: Array<{ scheme: string; code: string }>
  scope_note?: string
  season_basis?: string
  seasons: string[]
  default_season?: string
  default_country?: string
  valuation_methods: ValuationMethod[]
  [k: string]: unknown
}

const OBSERVATIONS = sample.observations as SampleObservation[]
const GEO = sample.geo as GeoUnit[]
const COMMODITIES = sample.commodities as unknown as Record<string, SampleCommodity>
const MEASURES = sample.measures as Record<
  string,
  { label: string; short?: string; unit: string; format: string; caption?: string }
>
const SOURCES = (sample.sources ?? {}) as Record<
  string,
  { name?: string; short?: string }
>
const META = sample.meta as { disclaimer?: string; intro?: string }
const CONFIG = sample.config as { ranking_size?: number; default_commodity?: string }

/** Countries only (the WLD aggregate is an observation key, not a geo_unit). */
const COUNTRIES = GEO.filter(g => g.level === 'country')

// ── Public option shapes used to populate the control row ───────────────────

export interface CommodityOption {
  id: string
  name: string
}

export interface CommodityMeta {
  id: string
  name: string
  codes: Array<{ scheme: string; code: string }>
  scopeNote: string
  seasonBasis: string
  seasons: string[]
  defaultSeason: string
  intro: string
}

export type ScopeKind = 'world' | 'continent' | 'zone'

export interface ScopeOption {
  id: string // 'WORLD' | continent name | zone name
  label: string
  kind: ScopeKind
}

/** The explorer's five headline/ranking measures. */
export type ExplorerMeasure =
  | 'production'
  | 'value'
  | 'exports'
  | 'export_value'
  | 'export_share'

export const HEADLINE_MEASURES: ExplorerMeasure[] = [
  'production',
  'value',
  'exports',
  'export_value',
]

export const RANKING_MEASURES: ExplorerMeasure[] = [
  'production',
  'value',
  'exports',
  'export_value',
  'export_share',
]

/** Measures that can be shown on the map (export_share is a ratio, 0–1). */
export const MAP_MEASURES: ExplorerMeasure[] = [
  'production',
  'value',
  'exports',
  'export_value',
  'export_share',
]

// ── Control-row data ────────────────────────────────────────────────────────

export function listCommodityOptions(): CommodityOption[] {
  return Object.values(COMMODITIES).map(c => ({ id: c.id, name: c.name }))
}

export function getDefaultCommodity(): string {
  return CONFIG.default_commodity ?? Object.keys(COMMODITIES)[0]
}

export function getCommodityMeta(commodity: string): CommodityMeta | null {
  const c = COMMODITIES[commodity]
  if (!c) return null
  const intro = (META.intro ?? '').replace(/\{commodity\}/g, c.name.toLowerCase())
  return {
    id: c.id,
    name: c.name,
    codes: c.codes ?? [],
    scopeNote: c.scope_note ?? '',
    seasonBasis: c.season_basis ?? '',
    seasons: c.seasons.slice(),
    defaultSeason: c.default_season ?? c.seasons[c.seasons.length - 1],
    intro,
  }
}

export function getCommodityValuationMethods(commodity: string): ValuationMethod[] {
  return getValuationMethods(commodity)
}

/** Count of distinct countries with ANY observation for a commodity/season. */
export function countriesReportingInSeason(commodity: string, season: string): number {
  const ids = new Set(
    OBSERVATIONS.filter(
      o => o.commodity === commodity && o.season === season && o.geo !== WORLD,
    ).map(o => o.geo),
  )
  return ids.size
}

/** Scope options: World, then each continent present, then each trade zone. */
export function listScopeOptions(): ScopeOption[] {
  const continents = Array.from(
    new Set(COUNTRIES.map(c => c.continent).filter(Boolean) as string[]),
  ).sort()
  const zones = Array.from(
    new Set(COUNTRIES.flatMap(c => c.zones ?? [])),
  ).sort()
  return [
    { id: 'WORLD', label: 'World', kind: 'world' },
    ...continents.map<ScopeOption>(c => ({ id: c, label: c, kind: 'continent' })),
    ...zones.map<ScopeOption>(z => ({ id: z, label: z, kind: 'zone' })),
  ]
}

/** The country ids inside a scope (World = all seeded countries). */
function countriesInScope(scope: ScopeOption): GeoUnit[] {
  if (scope.kind === 'world') return COUNTRIES
  if (scope.kind === 'continent') return COUNTRIES.filter(c => c.continent === scope.id)
  return COUNTRIES.filter(c => (c.zones ?? []).includes(scope.id))
}

// ── Measure resolution (per country, honouring valuation + fill) ────────────

interface MeasureCell {
  value: number | null
  filled: boolean
  filledFrom?: string
  /** true when the figure needed a price that was unavailable. */
  noPrice?: boolean
}

/** Resolve the production VALUE for a country using the chosen valuation method. */
function resolveValue(
  commodity: string,
  season: string,
  geo: string,
  method: ValuationMethod,
  fill: boolean,
): MeasureCell {
  // Production (respecting the fill toggle). getMeasureFilled always attempts a
  // forward-fill; when fill is OFF we only accept an exact (unfilled) figure.
  const production = (() => {
    const f = getMeasureFilled(commodity, 'production', season, geo)
    if (!f) return null
    if (!fill && f.filled) return null
    return f
  })()
  if (!production) return { value: null, filled: false }

  // Price: global method uses a price series; local uses the producer price.
  let price: number | null = null
  if (method.price_series) {
    const p = getPrice(commodity, method.price_series, season)
    price = p ? p.value : null
  } else if (method.price_measure === 'producer_price') {
    const pp = getProducerPrice(commodity, season, geo)
    price = pp ? pp.value : null
  }
  if (price == null) {
    return { value: null, filled: production.filled, filledFrom: production.filledFrom, noPrice: true }
  }
  return {
    value: production.value * price,
    filled: production.filled,
    filledFrom: production.filledFrom,
  }
}

/** Resolve a single measure for a country in a single season. */
function resolveMeasure(
  commodity: string,
  measure: ExplorerMeasure,
  season: string,
  geo: string,
  method: ValuationMethod,
  fill: boolean,
): MeasureCell {
  if (measure === 'value') {
    return resolveValue(commodity, season, geo, method, fill)
  }
  if (measure === 'export_share') {
    // exports ÷ production (both from the same season, honouring fill).
    const exp = resolveRaw(commodity, 'exports', season, geo, fill)
    const prod = resolveRaw(commodity, 'production', season, geo, fill)
    if (exp.value == null || prod.value == null || prod.value === 0) {
      return { value: null, filled: exp.filled || prod.filled, filledFrom: exp.filledFrom ?? prod.filledFrom }
    }
    return {
      value: exp.value / prod.value,
      filled: exp.filled || prod.filled,
      filledFrom: exp.filledFrom ?? prod.filledFrom,
    }
  }
  // production | exports | export_value — raw stored measures.
  return resolveRaw(commodity, measure, season, geo, fill)
}

function resolveRaw(
  commodity: string,
  measure: string,
  season: string,
  geo: string,
  fill: boolean,
): MeasureCell {
  if (fill) {
    const f = getMeasureFilled(commodity, measure, season, geo)
    if (!f) return { value: null, filled: false }
    return { value: f.value, filled: f.filled, filledFrom: f.filledFrom }
  }
  const f = getMeasureFilled(commodity, measure, season, geo)
  if (!f || f.filled) return { value: null, filled: false }
  return { value: f.value, filled: false }
}

/**
 * Combine a measure across MULTIPLE seasons for a country: sum (Total) or mean
 * (Annual average). Only seasons where the measure resolves contribute. A ratio
 * measure (export_share) is always averaged (summing a share is meaningless).
 */
function resolveMultiSeason(
  commodity: string,
  measure: ExplorerMeasure,
  seasons: string[],
  geo: string,
  method: ValuationMethod,
  fill: boolean,
  annualAverage: boolean,
): MeasureCell {
  const cells = seasons.map(s => resolveMeasure(commodity, measure, s, geo, method, fill))
  const present = cells.filter(c => c.value != null) as Array<Required<Pick<MeasureCell, 'value'>> & MeasureCell>
  if (present.length === 0) {
    return {
      value: null,
      filled: false,
      noPrice: cells.some(c => c.noPrice),
    }
  }
  const sum = present.reduce((acc, c) => acc + (c.value as number), 0)
  const isRatio = measure === 'export_share'
  const value = isRatio || annualAverage ? sum / present.length : sum
  return {
    value,
    filled: present.some(c => c.filled),
    filledFrom: present.find(c => c.filled)?.filledFrom,
    noPrice: cells.some(c => c.noPrice),
  }
}

// ── View-model output shapes ────────────────────────────────────────────────

export interface HeadlineCard {
  measure: ExplorerMeasure
  label: string
  unit: string
  format: string
  /** aggregated value over the scope (sum for levels, mean for share). */
  value: number | null
  /** countries that contributed a value. */
  counted: number
  /** countries in scope with no value for this measure. */
  notCounted: number
  /** countries whose value was forward-filled. */
  filled: number
  /** the same measure aggregated over ALL seeded countries (world comparison). */
  worldValue: number | null
  /** scope value as a share of world (0–1), when both are present and meaningful. */
  shareOfWorld: number | null
}

export interface MapCountry {
  iso3: string
  m49: string
  name: string
  continent?: string
  value: number | null
  filled: boolean
  filledFrom?: string
  /** 'in-scope' | 'no-data' | 'outside-scope'. */
  state: 'in-scope' | 'no-data' | 'outside-scope'
}

export interface RankingRow {
  rank: number
  iso3: string
  name: string
  value: number
  /** fraction of the ranking's total (0–1). */
  share: number
  filled: boolean
  filledFrom?: string
}

export interface RankingList {
  measure: ExplorerMeasure
  label: string
  unit: string
  format: string
  rows: RankingRow[]
  /** total across the ranked rows (used for share). */
  total: number
  /** countries in scope with no value for this measure. */
  missingCount: number
  /** countries skipped because no price was available (value only). */
  noPriceCount: number
}

export interface AboutFigures {
  commodityName: string
  intro: string
  codes: Array<{ scheme: string; code: string }>
  seasons: string[]
  seasonBasis: string
  gapFill: boolean
  valuationLabel: string
  valuationDescription: string
  priceCaveat: string
  disclaimer: string
}

export interface ExplorerParams {
  commodity: string
  seasons: string[]
  annualAverage: boolean
  valuationMethod: string
  fillGaps: boolean
  scope: string // ScopeOption.id
  /** the measure currently displayed on the map. */
  mapMeasure: ExplorerMeasure
}

export interface ExplorerView {
  cards: HeadlineCard[]
  map: MapCountry[]
  rankings: RankingList[]
  about: AboutFigures
  mapMeasure: ExplorerMeasure
}

// ── Builder ─────────────────────────────────────────────────────────────────

function measureMeta(measure: ExplorerMeasure) {
  const m = MEASURES[measure]
  return {
    label: m?.label ?? measure,
    unit: m?.unit ?? '',
    format: m?.format ?? 'number',
  }
}

function resolveMethod(commodity: string, methodId: string): ValuationMethod {
  const methods = getValuationMethods(commodity)
  return methods.find(m => m.id === methodId) ?? methods[0]
}

function resolveScope(scopeId: string): ScopeOption {
  return listScopeOptions().find(s => s.id === scopeId) ?? { id: 'WORLD', label: 'World', kind: 'world' }
}

/** Aggregate one measure over a set of countries. */
function aggregateMeasure(
  commodity: string,
  measure: ExplorerMeasure,
  seasons: string[],
  countries: GeoUnit[],
  method: ValuationMethod,
  fill: boolean,
  annualAverage: boolean,
): { value: number | null; counted: number; notCounted: number; filled: number; noPrice: number } {
  const isRatio = measure === 'export_share'
  let sum = 0
  let counted = 0
  let notCounted = 0
  let filled = 0
  let noPrice = 0
  for (const c of countries) {
    const cell = resolveMultiSeason(commodity, measure, seasons, c.id, method, fill, annualAverage)
    if (cell.value == null) {
      notCounted++
      if (cell.noPrice) noPrice++
      continue
    }
    counted++
    if (cell.filled) filled++
    sum += cell.value
  }
  if (counted === 0) return { value: null, counted, notCounted, filled, noPrice }
  // A share aggregated over countries is a (simple) average of shares.
  const value = isRatio ? sum / counted : sum
  return { value, counted, notCounted, filled, noPrice }
}

export function buildExplorerView(params: ExplorerParams): ExplorerView {
  const { commodity, fillGaps, annualAverage } = params
  const method = resolveMethod(commodity, params.valuationMethod)
  const scope = resolveScope(params.scope)
  const scopeCountries = countriesInScope(scope)
  const scopeIds = new Set(scopeCountries.map(c => c.id))

  // Only use seasons the commodity actually has; fall back to its default.
  const meta = getCommodityMeta(commodity)
  const validSeasons = (params.seasons.length
    ? params.seasons.filter(s => meta?.seasons.includes(s))
    : []
  )
  const seasons = validSeasons.length ? validSeasons : meta ? [meta.defaultSeason] : []

  // ── Headline cards ──────────────────────────────────────────────────────
  const cards: HeadlineCard[] = HEADLINE_MEASURES.map(measure => {
    const mm = measureMeta(measure)
    const scopeAgg = aggregateMeasure(
      commodity, measure, seasons, scopeCountries, method, fillGaps, annualAverage,
    )
    const worldAgg = aggregateMeasure(
      commodity, measure, seasons, COUNTRIES, method, fillGaps, annualAverage,
    )
    const isRatio = measure === 'export_share'
    const shareOfWorld =
      !isRatio && scopeAgg.value != null && worldAgg.value != null && worldAgg.value !== 0
        ? scopeAgg.value / worldAgg.value
        : null
    return {
      measure,
      label: mm.label,
      unit: mm.unit,
      format: mm.format,
      value: scopeAgg.value,
      counted: scopeAgg.counted,
      notCounted: scopeAgg.notCounted,
      filled: scopeAgg.filled,
      worldValue: worldAgg.value,
      shareOfWorld,
    }
  })

  // ── Choropleth map (ALL seeded countries; scope marks outside-scope) ─────
  const mapMeasure = params.mapMeasure
  const map: MapCountry[] = COUNTRIES.map(c => {
    const inScope = scopeIds.has(c.id)
    if (!inScope) {
      return {
        iso3: c.id,
        m49: c.m49 ?? '',
        name: c.name,
        continent: c.continent,
        value: null,
        filled: false,
        state: 'outside-scope',
      }
    }
    const cell = resolveMultiSeason(commodity, mapMeasure, seasons, c.id, method, fillGaps, annualAverage)
    return {
      iso3: c.id,
      m49: c.m49 ?? '',
      name: c.name,
      continent: c.continent,
      value: cell.value,
      filled: cell.filled,
      filledFrom: cell.filledFrom,
      state: cell.value == null ? 'no-data' : 'in-scope',
    }
  })

  // ── Rankings (top N within scope) ────────────────────────────────────────
  const rankingSize = CONFIG.ranking_size ?? 10
  const rankings: RankingList[] = RANKING_MEASURES.map(measure => {
    const mm = measureMeta(measure)
    const isRatio = measure === 'export_share'
    const resolved = scopeCountries.map(c => ({
      c,
      cell: resolveMultiSeason(commodity, measure, seasons, c.id, method, fillGaps, annualAverage),
    }))
    const present = resolved.filter(r => r.cell.value != null)
    const missingCount = resolved.length - present.length
    const noPriceCount = resolved.filter(r => r.cell.value == null && r.cell.noPrice).length
    const sorted = present
      .sort((a, b) => (b.cell.value as number) - (a.cell.value as number))
      .slice(0, rankingSize)
    // For level measures, share is of the ranked-countries total; for a ratio,
    // the "share of total" is not meaningful, so we report the value itself as
    // the bar fraction relative to the largest value.
    const total = isRatio
      ? Math.max(...sorted.map(r => r.cell.value as number), 0)
      : sorted.reduce((acc, r) => acc + (r.cell.value as number), 0)
    const rows: RankingRow[] = sorted.map((r, i) => ({
      rank: i + 1,
      iso3: r.c.id,
      name: r.c.name,
      value: r.cell.value as number,
      share: total > 0 ? (r.cell.value as number) / total : 0,
      filled: r.cell.filled,
      filledFrom: r.cell.filledFrom,
    }))
    return {
      measure,
      label: mm.label,
      unit: mm.unit,
      format: mm.format,
      rows,
      total,
      missingCount,
      noPriceCount,
    }
  })

  // ── About these figures ──────────────────────────────────────────────────
  const priceCaveat = method.caveat ?? ''
  const about: AboutFigures = {
    commodityName: meta?.name ?? commodity,
    intro: meta?.intro ?? '',
    codes: meta?.codes ?? [],
    seasons,
    seasonBasis: meta?.seasonBasis ?? '',
    gapFill: fillGaps,
    valuationLabel: method?.label ?? '',
    valuationDescription: method?.description ?? '',
    priceCaveat,
    disclaimer: META.disclaimer ?? '',
  }

  return { cards, map, rankings, about, mapMeasure }
}

/** Human source label for a source id (used in notes), if present. */
export function sourceLabel(id?: string): string | undefined {
  if (!id) return undefined
  const s = SOURCES[id]
  return s?.short ?? s?.name ?? id
}
