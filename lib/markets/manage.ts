/**
 * Markets curation data layer (MKT-6) — server-side only.
 * ──────────────────────────────────────────────────────────────────────────
 * The write side of Markets. Every reference / fact table that managers curate
 * (geo units, sources, prices, FX rates, structure notes, commodities and the
 * valuation-method lists embedded in commodities) is read and mutated here,
 * ALWAYS against the real schema from migrations 072 / 075:
 *
 *   markets_geo_units, markets_sources, markets_prices, markets_fx,
 *   markets_structure, markets_commodities (+ valuation_methods JSONB)
 *
 * Every mutation:
 *   1. runs through the service-role admin client (route-level role gating in
 *      the middleware + the API handlers authorises the caller);
 *   2. is SOFT-DELETE aware — "archive" sets archived_at rather than deleting,
 *      and the public list helpers exclude archived rows so dropdowns hide them
 *      while the audit log keeps the history;
 *   3. writes an IMMUTABLE audit entry to markets_audit via logChange().
 *
 * ⚠️  Import only in server-side code (Route Handlers / Server Components).
 */

import { createAdminClient } from '../supabase/admin'
import { logChange, type MarketsAuditAction } from './audit'
import type { SupabaseClient } from '@supabase/supabase-js'

// ── Shared types ────────────────────────────────────────────────────────────

/** A geo unit row (countries + sub-national regions). */
export interface GeoUnitRow {
  id: string
  name: string
  level: 'country' | 'region'
  m49: string | null
  continent: string | null
  zones: string[]
  parent: string | null
  region_type: string | null
  archived_at: string | null
}

/** A source registry row. */
export interface SourceRow {
  id: string
  name: string
  short: string | null
  url: string | null
  method: string | null
  licence: string | null
  vintage: string | null
  archived_at: string | null
}

/** A price-series observation row. */
export interface PriceRow {
  id: string
  commodity: string
  series: string
  season: string
  value: number
  unit: string | null
  source: string | null
  note: string | null
  archived_at: string | null
}

/** An FX-rate row. */
export interface FxRow {
  id: string
  pair: string
  season: string
  rate: number
  source: string | null
  note: string | null
  archived_at: string | null
}

/** A farm-structure row (per commodity + geo). */
export interface StructureRow {
  id: string
  commodity: string
  geo: string
  note: string | null
  classifications: Record<string, unknown>
  breakdowns: unknown[]
  sources: unknown[]
  archived_at: string | null
}

/** A commodity row (the valuation_methods JSONB is curated separately). */
export interface CommodityRow {
  id: string
  name: string
  scope_note: string | null
  season_basis: string | null
  seasons: string[]
  default_season: string | null
  default_country: string | null
  valuation_methods: ValuationMethodItem[]
  sort_order: number
  archived_at: string | null
}

/** One valuation method inside a commodity's valuation_methods JSONB array. */
export interface ValuationMethodItem {
  id: string
  label: string
  price_series?: string
  price_measure?: string
  description?: string
  caveat?: string
}

/** The curated reference/fact tables this module manages. */
export type ManagedTable =
  | 'markets_geo_units'
  | 'markets_sources'
  | 'markets_prices'
  | 'markets_fx'
  | 'markets_structure'
  | 'markets_commodities'

// ── Internal helpers ────────────────────────────────────────────────────────

function db(): SupabaseClient {
  return createAdminClient()
}

/** Throw a helpful error when a Supabase operation fails. */
function assertOk(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`[markets] ${what} failed: ${error.message}`)
}

// ── Geo units ───────────────────────────────────────────────────────────────

/**
 * List geo units. Archived rows are excluded unless includeArchived is set
 * (the manage table shows them with a badge; dropdowns never do).
 */
export async function listGeoUnits(opts?: { includeArchived?: boolean }): Promise<GeoUnitRow[]> {
  let q = db().from('markets_geo_units').select('*').order('level').order('name')
  if (!opts?.includeArchived) q = q.is('archived_at', null)
  const { data, error } = await q
  assertOk(error, 'list geo units')
  return (data ?? []) as GeoUnitRow[]
}

export interface GeoUnitInput {
  id: string
  name: string
  level: 'country' | 'region'
  m49?: string | null
  continent?: string | null
  zones?: string[]
  parent?: string | null
  region_type?: string | null
}

export async function createGeoUnit(input: GeoUnitInput, actorId: string | null): Promise<GeoUnitRow> {
  const row = {
    id: input.id,
    name: input.name,
    level: input.level,
    m49: input.m49 ?? null,
    continent: input.continent ?? null,
    zones: input.zones ?? [],
    parent: input.parent ?? null,
    region_type: input.region_type ?? null,
  }
  const { data, error } = await db().from('markets_geo_units').insert(row).select().single()
  assertOk(error, 'create geo unit')
  await logChange({ actorId, action: 'insert', targetTable: 'markets_geo_units', rowId: input.id, newValue: data as Record<string, unknown> })
  return data as GeoUnitRow
}

export async function updateGeoUnit(id: string, input: Partial<GeoUnitInput>, actorId: string | null): Promise<GeoUnitRow> {
  const before = await getRow('markets_geo_units', id)
  const { data, error } = await db().from('markets_geo_units').update(stripId(input)).eq('id', id).select().single()
  assertOk(error, 'update geo unit')
  await logChange({ actorId, action: 'update', targetTable: 'markets_geo_units', rowId: id, oldValue: before, newValue: data as Record<string, unknown> })
  return data as GeoUnitRow
}

// ── Sources ─────────────────────────────────────────────────────────────────

export async function listSources(opts?: { includeArchived?: boolean }): Promise<SourceRow[]> {
  let q = db().from('markets_sources').select('*').order('name')
  if (!opts?.includeArchived) q = q.is('archived_at', null)
  const { data, error } = await q
  assertOk(error, 'list sources')
  return (data ?? []) as SourceRow[]
}

export interface SourceInput {
  id: string
  name: string
  short?: string | null
  url?: string | null
  method?: string | null
  licence?: string | null
  vintage?: string | null
}

export async function createSource(input: SourceInput, actorId: string | null): Promise<SourceRow> {
  const row = {
    id: input.id,
    name: input.name,
    short: input.short ?? null,
    url: input.url ?? null,
    method: input.method ?? null,
    licence: input.licence ?? null,
    vintage: input.vintage ?? null,
  }
  const { data, error } = await db().from('markets_sources').insert(row).select().single()
  assertOk(error, 'create source')
  await logChange({ actorId, action: 'insert', targetTable: 'markets_sources', rowId: input.id, newValue: data as Record<string, unknown> })
  return data as SourceRow
}

export async function updateSource(id: string, input: Partial<SourceInput>, actorId: string | null): Promise<SourceRow> {
  const before = await getRow('markets_sources', id)
  const { data, error } = await db().from('markets_sources').update(stripId(input)).eq('id', id).select().single()
  assertOk(error, 'update source')
  await logChange({ actorId, action: 'update', targetTable: 'markets_sources', rowId: id, oldValue: before, newValue: data as Record<string, unknown> })
  return data as SourceRow
}

// ── Prices ──────────────────────────────────────────────────────────────────

export async function listPrices(opts?: { includeArchived?: boolean; commodity?: string }): Promise<PriceRow[]> {
  let q = db().from('markets_prices').select('*').order('commodity').order('series').order('season')
  if (!opts?.includeArchived) q = q.is('archived_at', null)
  if (opts?.commodity) q = q.eq('commodity', opts.commodity)
  const { data, error } = await q
  assertOk(error, 'list prices')
  return (data ?? []) as PriceRow[]
}

export interface PriceInput {
  commodity: string
  series: string
  season: string
  value: number
  unit?: string | null
  source?: string | null
  note?: string | null
}

export async function createPrice(input: PriceInput, actorId: string | null): Promise<PriceRow> {
  const row = {
    commodity: input.commodity,
    series: input.series,
    season: input.season,
    value: input.value,
    unit: input.unit ?? null,
    source: input.source ?? null,
    note: input.note ?? null,
  }
  const { data, error } = await db().from('markets_prices').insert(row).select().single()
  assertOk(error, 'create price')
  const created = data as PriceRow
  await logChange({ actorId, action: 'insert', targetTable: 'markets_prices', rowId: created.id, newValue: data as Record<string, unknown> })
  return created
}

export async function updatePrice(id: string, input: Partial<PriceInput>, actorId: string | null): Promise<PriceRow> {
  const before = await getRow('markets_prices', id)
  const { data, error } = await db().from('markets_prices').update(input).eq('id', id).select().single()
  assertOk(error, 'update price')
  await logChange({ actorId, action: 'update', targetTable: 'markets_prices', rowId: id, oldValue: before, newValue: data as Record<string, unknown> })
  return data as PriceRow
}

// ── FX rates ────────────────────────────────────────────────────────────────

export async function listFx(opts?: { includeArchived?: boolean }): Promise<FxRow[]> {
  let q = db().from('markets_fx').select('*').order('pair').order('season')
  if (!opts?.includeArchived) q = q.is('archived_at', null)
  const { data, error } = await q
  assertOk(error, 'list fx')
  return (data ?? []) as FxRow[]
}

export interface FxInput {
  pair: string
  season: string
  rate: number
  source?: string | null
  note?: string | null
}

export async function createFx(input: FxInput, actorId: string | null): Promise<FxRow> {
  const row = {
    pair: input.pair,
    season: input.season,
    rate: input.rate,
    source: input.source ?? null,
    note: input.note ?? null,
  }
  const { data, error } = await db().from('markets_fx').insert(row).select().single()
  assertOk(error, 'create fx')
  const created = data as FxRow
  await logChange({ actorId, action: 'insert', targetTable: 'markets_fx', rowId: created.id, newValue: data as Record<string, unknown> })
  return created
}

export async function updateFx(id: string, input: Partial<FxInput>, actorId: string | null): Promise<FxRow> {
  const before = await getRow('markets_fx', id)
  const { data, error } = await db().from('markets_fx').update(input).eq('id', id).select().single()
  assertOk(error, 'update fx')
  await logChange({ actorId, action: 'update', targetTable: 'markets_fx', rowId: id, oldValue: before, newValue: data as Record<string, unknown> })
  return data as FxRow
}

// ── Structure ───────────────────────────────────────────────────────────────

export async function listStructure(opts?: { includeArchived?: boolean; commodity?: string }): Promise<StructureRow[]> {
  let q = db().from('markets_structure').select('*').order('commodity').order('geo')
  if (!opts?.includeArchived) q = q.is('archived_at', null)
  if (opts?.commodity) q = q.eq('commodity', opts.commodity)
  const { data, error } = await q
  assertOk(error, 'list structure')
  return (data ?? []) as StructureRow[]
}

export interface StructureInput {
  commodity: string
  geo: string
  note?: string | null
  classifications?: Record<string, unknown>
  breakdowns?: unknown[]
  sources?: unknown[]
}

export async function createStructure(input: StructureInput, actorId: string | null): Promise<StructureRow> {
  const row = {
    commodity: input.commodity,
    geo: input.geo,
    note: input.note ?? null,
    classifications: input.classifications ?? {},
    breakdowns: input.breakdowns ?? [],
    sources: input.sources ?? [],
  }
  const { data, error } = await db().from('markets_structure').insert(row).select().single()
  assertOk(error, 'create structure')
  const created = data as StructureRow
  await logChange({ actorId, action: 'insert', targetTable: 'markets_structure', rowId: created.id, newValue: data as Record<string, unknown> })
  return created
}

export async function updateStructure(id: string, input: Partial<StructureInput>, actorId: string | null): Promise<StructureRow> {
  const before = await getRow('markets_structure', id)
  const { data, error } = await db().from('markets_structure').update(input).eq('id', id).select().single()
  assertOk(error, 'update structure')
  await logChange({ actorId, action: 'update', targetTable: 'markets_structure', rowId: id, oldValue: before, newValue: data as Record<string, unknown> })
  return data as StructureRow
}

// ── Commodities (+ embedded valuation methods) ──────────────────────────────

export async function listCommodities(opts?: { includeArchived?: boolean }): Promise<CommodityRow[]> {
  let q = db()
    .from('markets_commodities')
    .select('id, name, scope_note, season_basis, seasons, default_season, default_country, valuation_methods, sort_order, archived_at')
    .order('sort_order')
    .order('name')
  if (!opts?.includeArchived) q = q.is('archived_at', null)
  const { data, error } = await q
  assertOk(error, 'list commodities')
  return (data ?? []) as CommodityRow[]
}

export interface CommodityInput {
  id: string
  name: string
  scope_note?: string | null
  season_basis?: string | null
  seasons?: string[]
  default_season?: string | null
  default_country?: string | null
  sort_order?: number
}

export async function createCommodity(input: CommodityInput, actorId: string | null): Promise<CommodityRow> {
  const row = {
    id: input.id,
    name: input.name,
    scope_note: input.scope_note ?? null,
    season_basis: input.season_basis ?? null,
    seasons: input.seasons ?? [],
    default_season: input.default_season ?? null,
    default_country: input.default_country ?? null,
    sort_order: input.sort_order ?? 0,
  }
  const { data, error } = await db()
    .from('markets_commodities')
    .insert(row)
    .select('id, name, scope_note, season_basis, seasons, default_season, default_country, valuation_methods, sort_order, archived_at')
    .single()
  assertOk(error, 'create commodity')
  await logChange({ actorId, action: 'insert', targetTable: 'markets_commodities', rowId: input.id, newValue: data as Record<string, unknown> })
  return data as CommodityRow
}

export async function updateCommodity(id: string, input: Partial<CommodityInput>, actorId: string | null): Promise<CommodityRow> {
  const before = await getRow('markets_commodities', id)
  const patch = { ...stripId(input), updated_at: new Date().toISOString() }
  const { data, error } = await db()
    .from('markets_commodities')
    .update(patch)
    .eq('id', id)
    .select('id, name, scope_note, season_basis, seasons, default_season, default_country, valuation_methods, sort_order, archived_at')
    .single()
  assertOk(error, 'update commodity')
  await logChange({ actorId, action: 'update', targetTable: 'markets_commodities', rowId: id, oldValue: before, newValue: data as Record<string, unknown> })
  return data as CommodityRow
}

/**
 * Replace a commodity's valuation_methods JSONB array wholesale. Valuation
 * methods are curated (added / edited / removed) on the Data coverage manage
 * page, scoped to a commodity. Context-filtered dropdowns elsewhere read the
 * live (non-archived) commodity's methods.
 */
export async function setValuationMethods(
  commodity: string,
  methods: ValuationMethodItem[],
  actorId: string | null,
): Promise<CommodityRow> {
  const before = await getRow('markets_commodities', commodity)
  const { data, error } = await db()
    .from('markets_commodities')
    .update({ valuation_methods: methods, updated_at: new Date().toISOString() })
    .eq('id', commodity)
    .select('id, name, scope_note, season_basis, seasons, default_season, default_country, valuation_methods, sort_order, archived_at')
    .single()
  assertOk(error, 'set valuation methods')
  await logChange({
    actorId,
    action: 'update',
    targetTable: 'markets_commodities',
    rowId: commodity,
    oldValue: before,
    newValue: data as Record<string, unknown>,
    note: 'valuation_methods updated',
  })
  return data as CommodityRow
}

// ── Archive / restore (soft-delete) ─────────────────────────────────────────

/**
 * Archive (soft-delete) or restore a row in any managed table. Archiving sets
 * archived_at = now() so the row stays in the DB (and the audit history) but is
 * excluded from the public list helpers / dropdowns; restoring clears it.
 */
export async function setArchived(
  table: ManagedTable,
  id: string,
  archived: boolean,
  actorId: string | null,
): Promise<void> {
  const before = await getRow(table, id)
  const action: MarketsAuditAction = archived ? 'archive' : 'restore'
  const { data, error } = await db()
    .from(table)
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', id)
    .select()
    .single()
  assertOk(error, `${action} ${table}`)
  await logChange({ actorId, action, targetTable: table, rowId: id, oldValue: before, newValue: data as Record<string, unknown> })
}

// ── Low-level helpers ───────────────────────────────────────────────────────

/** Read a single row's current value (for the audit before-image). */
async function getRow(table: ManagedTable, id: string): Promise<Record<string, unknown> | null> {
  const { data } = await db().from(table).select('*').eq('id', id).maybeSingle()
  return (data as Record<string, unknown> | null) ?? null
}

/** Drop an `id` key from a patch so a row's primary key is never updated. */
function stripId<T extends { id?: unknown }>(input: T): Omit<T, 'id'> {
  const rest = { ...input }
  delete (rest as { id?: unknown }).id
  return rest
}
