/**
 * Markets secondary view-models (MKT-4).
 * ──────────────────────────────────────────────────────────────────────────
 * The Country profile, Farm structure, Data coverage and Sources tabs all
 * read from the same canonical `markets_sample.json` and compute every figure
 * through the MKT-2 compute layer (`lib/markets/compute.ts`) — exactly like the
 * Overview explorer (MKT-3). No maths is duplicated here: this module only
 * *assembles* the compute primitives into the shapes each tab renders.
 *
 * Design notes:
 *  - Pure, deterministic, no I/O — safe on the server or in the browser.
 *  - The views never invent numbers. A missing figure becomes an explicit
 *    `null`; a forward-filled figure carries the season it came from.
 *  - Scope (World / continent / zone) is shared with the Overview control row
 *    via the `ScopeOption` helpers re-exported from `explorer.ts`.
 */

import sample from '../../markets_sample.json' with { type: 'json' }
import {
  WORLD,
  getMeasureFilled,
  getYield,
  getExportShare,
  getStructure,
  getOperators,
  getRegions,
  getGapSource,
  getValuationMethods,
  getProducerPrice,
  getPrice,
  getFxRate,
  type GeoUnit,
  type StructureEntry,
  type Operator,
  type ValuationMethod,
  type Price,
  type FxRate,
} from './compute'
import {
  listScopeOptions,
  type ScopeOption,
} from './explorer'

// ── Source-shape slices (read-only views on the sample) ─────────────────────

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
  structure: Record<string, StructureEntry>
  gap_sources: Record<string, Record<string, string | undefined>>
  operators: Operator[]
  [k: string]: unknown
}

interface SourceEntry {
  name?: string
  short?: string
  url?: string
  method?: string
  licence?: string
  vintage?: string
}

interface CoverageDimension {
  label: string
  /** 'measure' | 'seasons' | 'regions' | 'operators' | 'classification' */
  kind: string
  measure?: string
  classification?: string
}

const GEO = sample.geo as GeoUnit[]
const COMMODITIES = sample.commodities as unknown as Record<string, SampleCommodity>
const MEASURES = sample.measures as Record<
  string,
  { label: string; short?: string; unit: string; format: string; caption?: string }
>
const SOURCES = (sample.sources ?? {}) as Record<string, SourceEntry>
const PRICES = (sample.prices ?? []) as Price[]
const FX = (sample.fx ?? []) as FxRate[]
const PRICE_SERIES = (sample.price_series ?? {}) as Record<
  string,
  { label?: string; basis?: string }
>
const CONFIG = sample.config as {
  ranking_size?: number
  coverage_top_n?: number
  default_commodity?: string
  coverage_dimensions?: CoverageDimension[]
}
const META = sample.meta as { disclaimer?: string; intro?: string }

const COUNTRIES = GEO.filter(g => g.level === 'country')

/** Human source label for a source id (short → name → id). */
export function sourceLabel(id?: string | null): string | undefined {
  if (!id) return undefined
  const s = SOURCES[id]
  return s?.short ?? s?.name ?? id
}

/** The country ids inside a scope (World = all seeded countries). */
function countriesInScope(scope: ScopeOption): GeoUnit[] {
  if (scope.kind === 'world') return COUNTRIES
  if (scope.kind === 'continent') return COUNTRIES.filter(c => c.continent === scope.id)
  return COUNTRIES.filter(c => (c.zones ?? []).includes(scope.id))
}

function resolveScope(scopeId: string): ScopeOption {
  return listScopeOptions().find(s => s.id === scopeId)
    ?? { id: 'WORLD', label: 'World', kind: 'world' }
}

function defaultCommodity(): string {
  return CONFIG.default_commodity ?? Object.keys(COMMODITIES)[0]
}

function measureMeta(measure: string) {
  const m = MEASURES[measure]
  return {
    label: m?.label ?? measure,
    short: m?.short ?? m?.label ?? measure,
    unit: m?.unit ?? '',
    format: m?.format ?? 'number',
    caption: m?.caption ?? '',
  }
}

// ── Shared country option helpers ───────────────────────────────────────────

export interface CountryOption {
  iso3: string
  name: string
  continent?: string
}

/** Countries that have ANY production observation for a commodity. */
export function listProducerCountries(commodity: string): CountryOption[] {
  const ids = new Set(
    (sample.observations as Array<{ commodity: string; measure: string; geo: string }>)
      .filter(o => o.commodity === commodity && o.measure === 'production' && o.geo !== WORLD)
      .map(o => o.geo),
  )
  return COUNTRIES.filter(c => ids.has(c.id)).map(c => ({
    iso3: c.id,
    name: c.name,
    continent: c.continent,
  }))
}

export function getDefaultCountry(commodity: string): string {
  const c = COMMODITIES[commodity]
  if (c?.default_country && getCountryName(c.default_country)) return c.default_country
  const producers = listProducerCountries(commodity)
  return producers[0]?.iso3 ?? ''
}

export function getCountryName(iso3: string): string | undefined {
  return COUNTRIES.find(c => c.id === iso3)?.name
}

// ════════════════════════════════════════════════════════════════════════════
// Country profile tab
// ════════════════════════════════════════════════════════════════════════════

export interface CountryMeasureCell {
  measure: string
  label: string
  short: string
  unit: string
  format: string
  caption: string
  /** resolved value for the country/season (null = no figure). */
  value: number | null
  /** true when the figure was forward-filled from an earlier season. */
  filled: boolean
  filledFrom?: string
  /** 1-based rank of this country among all producers for the measure (null = unranked). */
  rank: number | null
  /** number of countries ranked for this measure (the rank denominator). */
  rankOf: number
  /** source label backing the figure, if known. */
  source?: string
}

export interface CountrySeasonPoint {
  season: string
  value: number | null
  filled: boolean
}

export interface CountryRegionCard {
  iso3: string
  name: string
  regionType?: string
}

export interface CountryStructureCard {
  note?: string
  classifications: Array<{ key: string; status: string; detail: string }>
  breakdowns: Array<{ label: string; parts: Array<{ label: string; share: number }> }>
  sources: Array<{ id: string; label: string }>
}

export interface CountryProfileView {
  iso3: string
  name: string
  continent?: string
  m49?: string
  zones: string[]
  commodity: string
  commodityName: string
  season: string
  seasons: string[]
  /** all seven measures, resolved for the country/season with ranks. */
  measures: CountryMeasureCell[]
  /** production across every season (for the by-season chart). */
  productionBySeason: CountrySeasonPoint[]
  regions: CountryRegionCard[]
  regionsGapSource?: string
  structure: CountryStructureCard | null
  structureGapSource?: string
  operators: Operator[]
  operatorsGapSource?: string
  disclaimer: string
}

/** The seven measures shown on the Country tab, in display order. */
const COUNTRY_MEASURES = [
  'production',
  'area_harvested',
  'yield',
  'value',
  'exports',
  'export_value',
  'export_share',
] as const

/** Resolve a single measure value for a country/season through compute.ts. */
function resolveCountryMeasure(
  commodity: string,
  measure: string,
  season: string,
  geo: string,
  method: ValuationMethod | undefined,
): { value: number | null; filled: boolean; filledFrom?: string; source?: string } {
  if (measure === 'yield') {
    const y = getYield({ commodity, year: season, geography: geo })
    return { value: y ? y.value : null, filled: false }
  }
  if (measure === 'export_share') {
    const r = getExportShare({ commodity, year: season, geography: geo })
    return { value: r ? r.value : null, filled: false }
  }
  if (measure === 'value') {
    // Production × price (global price-series or local producer price).
    const prod = getMeasureFilled(commodity, 'production', season, geo)
    if (!prod) return { value: null, filled: false }
    let price: number | null = null
    let priceSource: string | undefined
    if (method?.price_series) {
      const p = getPrice(commodity, method.price_series, season)
      price = p ? p.value : null
      priceSource = p?.source
    } else if (method?.price_measure === 'producer_price') {
      const pp = getProducerPrice(commodity, season, geo)
      price = pp ? pp.value : null
      priceSource = pp?.source
    }
    if (price == null) return { value: null, filled: prod.filled, filledFrom: prod.filledFrom }
    return {
      value: prod.value * price,
      filled: prod.filled,
      filledFrom: prod.filledFrom,
      source: priceSource ?? prod.source,
    }
  }
  // production | area_harvested | exports | export_value — raw stored measures.
  const f = getMeasureFilled(commodity, measure, season, geo)
  if (!f) return { value: null, filled: false }
  return { value: f.value, filled: f.filled, filledFrom: f.filledFrom, source: f.source }
}

/** Rank a country among all producers for a measure/season (desc by value). */
function rankCountry(
  commodity: string,
  measure: string,
  season: string,
  geo: string,
  method: ValuationMethod | undefined,
): { rank: number | null; rankOf: number } {
  const values: Array<{ id: string; value: number }> = []
  for (const c of COUNTRIES) {
    const r = resolveCountryMeasure(commodity, measure, season, c.id, method)
    if (r.value != null) values.push({ id: c.id, value: r.value })
  }
  values.sort((a, b) => b.value - a.value)
  const idx = values.findIndex(v => v.id === geo)
  return { rank: idx >= 0 ? idx + 1 : null, rankOf: values.length }
}

export interface CountryProfileParams {
  commodity: string
  iso3: string
  season?: string
  valuationMethod?: string
}

export function buildCountryProfile(params: CountryProfileParams): CountryProfileView | null {
  const commodity = COMMODITIES[params.commodity] ? params.commodity : defaultCommodity()
  const geo = COUNTRIES.find(c => c.id === params.iso3)
  if (!geo) return null

  const meta = COMMODITIES[commodity]
  const seasons = meta.seasons.slice()
  const season = params.season && seasons.includes(params.season)
    ? params.season
    : meta.default_season ?? seasons[seasons.length - 1]

  const methods = getValuationMethods(commodity)
  const method = methods.find(m => m.id === params.valuationMethod) ?? methods[0]

  const measures: CountryMeasureCell[] = COUNTRY_MEASURES.map(m => {
    const mm = measureMeta(m)
    const cell = resolveCountryMeasure(commodity, m, season, geo.id, method)
    const { rank, rankOf } = rankCountry(commodity, m, season, geo.id, method)
    return {
      measure: m,
      label: mm.label,
      short: mm.short,
      unit: mm.unit,
      format: mm.format,
      caption: mm.caption,
      value: cell.value,
      filled: cell.filled,
      filledFrom: cell.filledFrom,
      rank,
      rankOf,
      source: sourceLabel(cell.source),
    }
  })

  const productionBySeason: CountrySeasonPoint[] = seasons.map(s => {
    const f = getMeasureFilled(commodity, 'production', s, geo.id)
    return {
      season: s,
      value: f ? f.value : null,
      filled: f ? f.filled : false,
    }
  })

  const regionUnits = getRegions(geo.id)
  const regions: CountryRegionCard[] = regionUnits.map(r => ({
    iso3: r.id,
    name: r.name,
    regionType: r.region_type,
  }))

  const structureEntry = getStructure(commodity, geo.id)
  const structure: CountryStructureCard | null = structureEntry
    ? {
        note: structureEntry.note,
        classifications: Object.entries(structureEntry.classifications ?? {}).map(
          ([key, [status, detail]]) => ({ key, status, detail }),
        ),
        breakdowns: structureEntry.breakdowns ?? [],
        sources: (structureEntry.sources ?? []).map(id => ({
          id,
          label: sourceLabel(id) ?? id,
        })),
      }
    : null

  const operators = getOperators(commodity, geo.id)

  return {
    iso3: geo.id,
    name: geo.name,
    continent: geo.continent,
    m49: geo.m49,
    zones: geo.zones ?? [],
    commodity,
    commodityName: meta.name,
    season,
    seasons,
    measures,
    productionBySeason,
    regions,
    regionsGapSource: regions.length === 0
      ? getGapSource(commodity, geo.id, 'regions') ?? undefined
      : undefined,
    structure,
    structureGapSource: structure === null
      ? getGapSource(commodity, geo.id, 'structure') ?? undefined
      : undefined,
    operators,
    operatorsGapSource: operators.length === 0
      ? getGapSource(commodity, geo.id, 'operators') ?? undefined
      : undefined,
    disclaimer: META.disclaimer ?? '',
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Farm structure tab
// ════════════════════════════════════════════════════════════════════════════

export interface StructureCountryCard {
  iso3: string
  name: string
  continent?: string
  note?: string
  classifications: Array<{ key: string; status: string; detail: string }>
  breakdowns: Array<{ label: string; parts: Array<{ label: string; share: number }> }>
  sources: Array<{ id: string; label: string }>
}

export interface StructureView {
  commodity: string
  commodityName: string
  scopeLabel: string
  cards: StructureCountryCard[]
  /** source used where a country has no structured record. */
  defaultGapSource?: string
  disclaimer: string
}

export interface StructureParams {
  commodity: string
  scope: string
}

export function buildStructureView(params: StructureParams): StructureView {
  const commodity = COMMODITIES[params.commodity] ? params.commodity : defaultCommodity()
  const meta = COMMODITIES[commodity]
  const scope = resolveScope(params.scope)
  const scopeIds = new Set(countriesInScope(scope).map(c => c.id))

  const cards: StructureCountryCard[] = Object.keys(meta.structure)
    .filter(iso3 => scopeIds.has(iso3))
    .map(iso3 => {
      const entry = meta.structure[iso3]
      const geo = COUNTRIES.find(c => c.id === iso3)
      return {
        iso3,
        name: geo?.name ?? iso3,
        continent: geo?.continent,
        note: entry.note,
        classifications: Object.entries(entry.classifications ?? {}).map(
          ([key, [status, detail]]) => ({ key, status, detail }),
        ),
        breakdowns: entry.breakdowns ?? [],
        sources: (entry.sources ?? []).map(id => ({ id, label: sourceLabel(id) ?? id })),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    commodity,
    commodityName: meta.name,
    scopeLabel: scope.label,
    cards,
    defaultGapSource: getGapSource(commodity, WORLD, 'structure') ?? undefined,
    disclaimer: META.disclaimer ?? '',
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Data coverage tab
// ════════════════════════════════════════════════════════════════════════════

export type CoverageStatus = 'have' | 'partial' | 'gap'

export interface CoverageCell {
  label: string
  status: CoverageStatus
  /** the latest season a figure exists for (shown on 'partial'). */
  latestSeason?: string
  /** optional short detail (e.g. region count). */
  detail?: string
}

export interface CoverageRow {
  iso3: string
  name: string
  continent?: string
  /** headline production used to rank (latest season, forward-filled). */
  production: number | null
  cells: CoverageCell[]
}

export interface CoverageView {
  commodity: string
  commodityName: string
  scopeLabel: string
  season: string
  dimensions: Array<{ label: string }>
  rows: CoverageRow[]
  topN: number
  disclaimer: string
}

/** Latest season with a direct (unfilled) observation for a measure/country. */
function latestSeasonWithMeasure(
  commodity: string,
  measure: string,
  geo: string,
  seasons: string[],
): string | undefined {
  for (const s of seasons.slice().reverse()) {
    const f = getMeasureFilled(commodity, measure, s, geo)
    if (f && !f.filled) return s
  }
  return undefined
}

function measureCoverage(
  commodity: string,
  measure: string,
  geo: string,
  season: string,
  seasons: string[],
  label: string,
): CoverageCell {
  // "Have" = a direct figure for the current season.
  const current = getMeasureFilled(commodity, measure, season, geo)
  if (current && !current.filled) return { label, status: 'have' }
  // "Partial" = a figure exists, but only for an earlier season.
  const latest = latestSeasonWithMeasure(commodity, measure, geo, seasons)
  if (latest) return { label, status: 'partial', latestSeason: latest }
  return { label, status: 'gap' }
}

function classificationCoverage(
  commodity: string,
  classification: string,
  geo: string,
  label: string,
): CoverageCell {
  const entry = COMMODITIES[commodity]?.structure?.[geo]
  const cls = entry?.classifications?.[classification]
  if (!cls) return { label, status: 'gap' }
  const [status] = cls
  if (status === 'ok') return { label, status: 'have' }
  if (status === 'part') return { label, status: 'partial' }
  return { label, status: 'gap' }
}

export interface CoverageParams {
  commodity: string
  scope: string
  season?: string
}

export function buildCoverageView(params: CoverageParams): CoverageView {
  const commodity = COMMODITIES[params.commodity] ? params.commodity : defaultCommodity()
  const meta = COMMODITIES[commodity]
  const seasons = meta.seasons.slice()
  const season = params.season && seasons.includes(params.season)
    ? params.season
    : meta.default_season ?? seasons[seasons.length - 1]
  const scope = resolveScope(params.scope)
  const scopeCountries = countriesInScope(scope)
  const topN = CONFIG.coverage_top_n ?? 12

  const dimensions = CONFIG.coverage_dimensions ?? [
    { label: 'Production', kind: 'measure', measure: 'production' },
    { label: 'Area', kind: 'measure', measure: 'area_harvested' },
    { label: 'Export vol.', kind: 'measure', measure: 'exports' },
    { label: 'Export value', kind: 'measure', measure: 'export_value' },
  ]

  // Rank by latest production (forward-filled so near-complete producers rank).
  const ranked = scopeCountries
    .map(c => {
      const f = getMeasureFilled(commodity, 'production', season, c.id)
      return { c, production: f ? f.value : null }
    })
    .filter(r => r.production != null)
    .sort((a, b) => (b.production as number) - (a.production as number))
    .slice(0, topN)

  const rows: CoverageRow[] = ranked.map(({ c, production }) => {
    const cells: CoverageCell[] = dimensions.map(dim => {
      switch (dim.kind) {
        case 'measure':
          return measureCoverage(commodity, dim.measure as string, c.id, season, seasons, dim.label)
        case 'seasons': {
          const measure = dim.measure ?? 'production'
          const count = seasons.filter(s => {
            const f = getMeasureFilled(commodity, measure, s, c.id)
            return f && !f.filled
          }).length
          if (count === 0) return { label: dim.label, status: 'gap' }
          if (count >= seasons.length) return { label: dim.label, status: 'have', detail: `${count}/${seasons.length}` }
          return { label: dim.label, status: 'partial', detail: `${count}/${seasons.length}` }
        }
        case 'regions': {
          const count = getRegions(c.id).length
          if (count === 0) return { label: dim.label, status: 'gap' }
          return { label: dim.label, status: 'have', detail: `${count}` }
        }
        case 'operators': {
          const count = getOperators(commodity, c.id).length
          if (count === 0) return { label: dim.label, status: 'gap' }
          return { label: dim.label, status: 'have', detail: `${count}` }
        }
        case 'classification':
          return classificationCoverage(commodity, dim.classification as string, c.id, dim.label)
        default:
          return { label: dim.label, status: 'gap' }
      }
    })
    return {
      iso3: c.id,
      name: c.name,
      continent: c.continent,
      production,
      cells,
    }
  })

  return {
    commodity,
    commodityName: meta.name,
    scopeLabel: scope.label,
    season,
    dimensions: dimensions.map(d => ({ label: d.label })),
    rows,
    topN,
    disclaimer: META.disclaimer ?? '',
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Sources tab
// ════════════════════════════════════════════════════════════════════════════

export interface SourceRow {
  id: string
  name: string
  short?: string
  url?: string
  method?: string
  licence?: string
  vintage?: string
  /** number of times this source id is referenced across the dataset. */
  uses: number
}

export interface SourcePriceRow {
  commodity: string
  commodityName: string
  series: string
  seriesLabel: string
  basis?: string
  season: string
  value: number
  unit?: string
  source?: string
  sourceLabel?: string
}

export interface SourceFxRow {
  pair: string
  season: string
  rate: number
  source?: string
  sourceLabel?: string
  note?: string
}

export interface SourcesView {
  sources: SourceRow[]
  prices: SourcePriceRow[]
  fx: SourceFxRow[]
  disclaimer: string
}

/** Count references to each source id across observations, prices, fx, structure, operators. */
function countSourceUses(): Record<string, number> {
  const counts: Record<string, number> = {}
  const bump = (id?: string | null) => {
    if (!id) return
    counts[id] = (counts[id] ?? 0) + 1
  }
  for (const o of sample.observations as Array<{ source?: string }>) bump(o.source)
  for (const p of PRICES) bump(p.source)
  for (const f of FX) bump(f.source)
  for (const c of Object.values(COMMODITIES)) {
    for (const s of Object.values(c.structure ?? {})) {
      for (const id of s.sources ?? []) bump(id)
    }
    for (const op of c.operators ?? []) bump(op.source)
  }
  return counts
}

export function buildSourcesView(): SourcesView {
  const uses = countSourceUses()

  const sources: SourceRow[] = Object.entries(SOURCES)
    .map(([id, s]) => ({
      id,
      name: s.name ?? s.short ?? id,
      short: s.short,
      url: s.url,
      method: s.method,
      licence: s.licence,
      vintage: s.vintage,
      uses: uses[id] ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const prices: SourcePriceRow[] = PRICES.map(p => ({
    commodity: p.commodity,
    commodityName: COMMODITIES[p.commodity]?.name ?? p.commodity,
    series: p.series,
    seriesLabel: PRICE_SERIES[p.series]?.label ?? p.series,
    basis: PRICE_SERIES[p.series]?.basis,
    season: p.season,
    value: p.value,
    unit: p.unit,
    source: p.source,
    sourceLabel: sourceLabel(p.source),
  })).sort(
    (a, b) =>
      a.commodityName.localeCompare(b.commodityName) ||
      a.seriesLabel.localeCompare(b.seriesLabel) ||
      a.season.localeCompare(b.season),
  )

  const fx: SourceFxRow[] = FX.map(f => ({
    pair: f.pair,
    season: f.season,
    rate: f.rate,
    source: f.source,
    sourceLabel: sourceLabel(f.source),
    note: f.note,
  }))

  return {
    sources,
    prices,
    fx,
    disclaimer: META.disclaimer ?? '',
  }
}

// Re-export scope helpers so view components import from one place.
export { listScopeOptions } from './explorer'
export type { ScopeOption } from './explorer'
