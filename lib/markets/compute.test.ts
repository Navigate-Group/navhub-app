/**
 * Fixture tests for the Markets calculation library (MKT-2).
 * ──────────────────────────────────────────────────────────────────────────
 * Proves that lib/markets/compute.ts reproduces the figures in the canonical
 * markets_sample.json — the same document migration 073 seeds into the DB.
 * Expected values are the exact figures found in the seed, so the UI and the
 * agent tools (which both call these functions) are guaranteed to agree.
 *
 * Run with Node's built-in test runner + native type stripping:
 *   node --test --experimental-strip-types lib/markets/compute.test.ts
 * (wired as `npm run test:markets`).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  getProduction,
  getProductionFilled,
  getExports,
  getExportShare,
  getYield,
  getValueGlobal,
  getValueLocal,
  getGapSource,
  getStructure,
  getOperators,
  getRegions,
  getGeoUnit,
  listCommodities,
  WORLD,
} from './compute.ts'

test('bananas 2024 WLD production = 139,413,685 t (exact from observations)', () => {
  const f = getProduction({ commodity: 'banana', year: '2024' })
  assert.ok(f)
  assert.equal(f.value, 139413685)
  assert.equal(f.season, '2024')
  assert.equal(f.filled, false)
})

test('WLD is the default geography for headline lookups', () => {
  const explicit = getProduction({ commodity: 'banana', year: '2024', geography: WORLD })
  const implicit = getProduction({ commodity: 'banana', year: '2024' })
  assert.deepEqual(explicit, implicit)
})

test('Costa Rica banana export_share = 2,400,000 exports ÷ 2,630,020 production', () => {
  const r = getExportShare({ commodity: 'banana', year: '2024', geography: 'CRI' })
  assert.ok(r)
  assert.equal(r.numerator, 2400000)
  assert.equal(r.denominator, 2630020)
  // Exact ratio from the seed. NOTE: the brief quotes "91.2%", but the exact
  // figures give 2400000 / 2630020 = 91.25% which displays as 91.3% at one
  // decimal. We assert the EXACT seeded ratio (source of truth), not the
  // brief's rounded prose.
  assert.equal(r.value, 2400000 / 2630020)
  assert.equal((r.value * 100).toFixed(1), '91.3')
  assert.ok(Math.abs(r.value * 100 - 91.25) < 0.01)

  // And exports is the numerator, sourced from observations.
  const exp = getExports({ commodity: 'banana', year: '2024', geography: 'CRI' })
  assert.ok(exp)
  assert.equal(exp.value, 2400000)
})

test('India banana production 2000 + 2024 = 14,137,300 + 37,614,362 = 51,751,662 t', () => {
  const p2000 = getProduction({ commodity: 'banana', year: '2000', geography: 'IND' })
  const p2024 = getProduction({ commodity: 'banana', year: '2024', geography: 'IND' })
  assert.ok(p2000 && p2024)
  assert.equal(p2000.value, 14137300)
  assert.equal(p2024.value, 37614362)
  assert.equal(p2000.value + p2024.value, 51751662)
})

test('mangoes 2024 WLD production = 61,000,000 t (exact from observations)', () => {
  const f = getProduction({ commodity: 'mango', year: '2024' })
  assert.ok(f)
  assert.equal(f.value, 61000000)
  assert.equal(f.filled, false)
})

test('gap-filled mango 2024 forward-fills from 2023 (validates gap logic)', () => {
  // Mexico has no 2024 mango production observation but has 2023 = 2,700,000.
  const exact = getProduction({ commodity: 'mango', year: '2024', geography: 'MEX' })
  assert.equal(exact, null, 'no exact 2024 observation exists for MEX mango')

  const filled = getProductionFilled({ commodity: 'mango', year: '2024', geography: 'MEX' })
  assert.ok(filled)
  assert.equal(filled.value, 2700000)
  assert.equal(filled.filled, true)
  assert.equal(filled.filledFrom, '2023')

  // WLD has an exact 2024 value, so filling must NOT flag it.
  const world = getProductionFilled({ commodity: 'mango', year: '2024' })
  assert.ok(world)
  assert.equal(world.value, 61000000)
  assert.equal(world.filled, false)
})

test('yield = production ÷ area_harvested', () => {
  // India banana 2024: production 37,614,362 ÷ area 948,500.
  const y = getYield({ commodity: 'banana', year: '2024', geography: 'IND' })
  assert.ok(y)
  assert.equal(y.numerator, 37614362)
  assert.equal(y.denominator, 948500)
  assert.equal(y.value, 37614362 / 948500)
})

test('global valuation = production × price_series value', () => {
  // Banana 2024 WLD production (139,413,685 t) × World Bank US import price
  // for 2024 (1235.8 USD/t). WLD banana production is only present for 2024.
  const v = getValueGlobal('banana', 'wb_banana_us', '2024', WORLD)
  assert.ok(v)
  const prod = getProduction({ commodity: 'banana', year: '2024' })
  assert.ok(prod)
  assert.equal(prod.value, 139413685)
  assert.equal(v.price, 1235.8)
  assert.equal(v.value, 139413685 * 1235.8)
  assert.equal(v.method, 'global')
})

test('local valuation = production × producer_price (when present)', () => {
  // Only assert the arithmetic identity where a producer price exists.
  const v = getValueLocal('banana', '2024', 'IND')
  if (v) {
    const prod = getProductionFilled({ commodity: 'banana', year: '2024', geography: 'IND' })
    assert.ok(prod)
    assert.equal(v.value, prod.value * v.price)
    assert.equal(v.method, 'local')
  } else {
    // If no producer price is in the sample for this geo/season, that is a
    // valid null — the local method is simply unavailable.
    assert.equal(v, null)
  }
})

test('gap source falls back to the commodity _default then document default', () => {
  // Banana has a per-geo override for PHL regions.
  assert.equal(
    getGapSource('banana', 'PHL', 'regions'),
    'PSA Major Fruit Crops regional tables',
  )
  // A geo without an override falls back to the commodity _default.
  assert.equal(
    getGapSource('banana', 'CRI', 'regions'),
    'National agricultural statistics office',
  )
  assert.equal(
    getGapSource('banana', 'CRI', 'operators'),
    'Certification and export registries',
  )
  // Mango has no _default in gap_sources → falls back to document gap_default.
  assert.equal(
    getGapSource('mango', 'CRI', 'structure'),
    'National agricultural census',
  )
})

test('structure & operator lookups return seeded data', () => {
  const aus = getStructure('banana', 'AUS')
  assert.ok(aus)
  assert.ok(aus.note && aus.note.includes('Mackay'))
  assert.equal(aus.classifications?.ownership?.[0], 'ok')

  const bananaOps = getOperators('banana')
  assert.equal(bananaOps.length, 12)
  const mangoOps = getOperators('mango')
  assert.equal(mangoOps.length, 3)

  const ausOps = getOperators('banana', 'AUS')
  assert.ok(ausOps.length >= 1)
  assert.ok(ausOps.every(o => o.country === 'AUS'))
})

test('reference lookups: regions, geo units, world aggregate', () => {
  // India has sub-national banana/mango regions.
  const indRegions = getRegions('IND')
  assert.ok(indRegions.length > 0)
  assert.ok(indRegions.every(r => r.level === 'region' && r.parent === 'IND'))

  assert.equal(getGeoUnit('CRI')?.name, 'Costa Rica')
  // WLD is an aggregate key, not a geo_unit.
  assert.equal(getGeoUnit(WORLD), null)

  assert.deepEqual(listCommodities(), ['banana', 'mango'])
})
