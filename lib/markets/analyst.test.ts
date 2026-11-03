/**
 * Fixture tests for the Market Analyst tool data path (MKT-5).
 * ──────────────────────────────────────────────────────────────────────────
 * The three tool routes (/api/markets/analyst/{country,ranking,change-view})
 * return figures straight from the compute/views/explorer engines. The route
 * handlers themselves are thin Next.js wrappers (auth + cache + logging) that
 * can't run under the native Node test runner, so these tests exercise the SAME
 * engines the routes call — proving the agent would cite the right numbers.
 *
 * Seeded case: bananas, 2024, World scope. The agent must be able to cite:
 *   - India ≈ 28% of world banana production (exact seed: 27.0%).
 *   - Costa Rica ≈ 91% banana export share (exact seed: 91.3%).
 *   - A production value with the global-price caveat.
 *
 * Also covers the cache-key builder and figure-attribution helpers.
 *
 * Run with: npm run test:markets (node --test --experimental-strip-types).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildCountryProfile } from './views.ts'
import { buildFullRanking } from './explorer.ts'
import { getExportShare, getValueGlobal, getValuationMethods } from './compute.ts'
import { buildCacheKey } from './analyst-cache.ts'
import { cellAttribution, figureAttribution } from './analyst-helpers.ts'

// ── Ranking tool: India ≈ 28% of world banana production (2024) ──────────────

test('ranking tool: India leads banana production and is ~28% of the ranked total', () => {
  const ranking = buildFullRanking(
    {
      commodity: 'banana',
      seasons: ['2024'],
      annualAverage: false,
      valuationMethod: '',
      fillGaps: true,
      scope: 'WORLD',
      mapMeasure: 'production',
    },
    'production',
  )

  // India must be the #1 ranked producer.
  const india = ranking.rows.find(r => r.iso3 === 'IND')
  assert.ok(india, 'India should be ranked')
  assert.equal(india!.rank, 1)
  assert.equal(india!.value, 37614362)

  // Its share of the ALL-ranked total rounds to ~28% (the brief's figure).
  // The exact seeded ratio against the ranked total is slightly under 28%.
  assert.equal(Math.round(india!.share * 100), 28)
})

// ── Country tool: Costa Rica banana export share ≈ 91% (2024) ────────────────

test('country tool: Costa Rica banana export share = 91.3% (2024)', () => {
  const profile = buildCountryProfile({ commodity: 'banana', iso3: 'CRI', season: '2024' })
  assert.ok(profile)
  assert.equal(profile!.season, '2024')

  const exportShare = profile!.measures.find(m => m.measure === 'export_share')
  assert.ok(exportShare, 'export_share measure should be present')
  assert.ok(exportShare!.value != null)
  assert.equal((exportShare!.value! * 100).toFixed(1), '91.3')

  // Cross-check against the compute primitive (single source of truth).
  const r = getExportShare({ commodity: 'banana', year: '2024', geography: 'CRI' })
  assert.ok(r)
  assert.equal(exportShare!.value, r!.value)
})

// ── Country tool: production value carries the global-price caveat ───────────

test('country tool: banana production value uses a global price with a caveat', () => {
  // The global valuation method must expose a caveat (surfaced to the agent).
  const methods = getValuationMethods('banana')
  const global = methods.find(m => m.price_series)
  assert.ok(global, 'a global (price-series) valuation method should exist')
  assert.ok(global!.caveat && global!.caveat.length > 0, 'global method should carry a caveat')

  // India's 2024 production value via the global method resolves to a number.
  const val = getValueGlobal('banana', global!.price_series as string, '2024', 'IND')
  assert.ok(val, 'global production value should resolve for India 2024')
  assert.equal(val!.method, 'global')
  assert.ok(val!.value > 0)
})

// ── Country tool: full profile returns all seven measures with attribution ───

test('country tool: India profile returns all seven measures', () => {
  const profile = buildCountryProfile({ commodity: 'banana', iso3: 'IND', season: '2024' })
  assert.ok(profile)
  assert.equal(profile!.measures.length, 7)
  const production = profile!.measures.find(m => m.measure === 'production')
  assert.ok(production)
  assert.equal(production!.value, 37614362)
  // India is the #1 producer in the country profile ranks too.
  assert.equal(production!.rank, 1)
})

// ── Cache-key builder: deterministic & season-order-insensitive ──────────────

test('cache key is deterministic and insensitive to season order', () => {
  const a = buildCacheKey(
    { commodityId: 'banana', seasonIds: ['2024', '2020'], scope: 'WORLD', fillGaps: true },
    'tool=ranking:production',
  )
  const b = buildCacheKey(
    { commodityId: 'banana', seasonIds: ['2020', '2024'], scope: 'WORLD', fillGaps: true },
    'tool=ranking:production',
  )
  assert.equal(a, b)

  // A different gap-fill flag yields a different key.
  const c = buildCacheKey(
    { commodityId: 'banana', seasonIds: ['2020', '2024'], scope: 'WORLD', fillGaps: false },
    'tool=ranking:production',
  )
  assert.notEqual(a, c)
})

// ── Figure attribution: season + derivation tagging ─────────────────────────

test('figure attribution tags season and forward-fill derivation', () => {
  assert.equal(figureAttribution({ season: '2024', filled: false }), '2024 figure')
  assert.equal(
    figureAttribution({ season: '2024', filled: true, filledFrom: '2022' }),
    '2024 figure, filled (carried forward from 2022)',
  )
  assert.equal(cellAttribution('2023', true, '2020'), '2023 figure, filled (carried forward from 2020)')
  assert.equal(cellAttribution('2024', false), '2024 figure')
})
