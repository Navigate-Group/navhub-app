/**
 * Fixture tests for the Markets Explorer view-model (MKT-3).
 * ──────────────────────────────────────────────────────────────────────────
 * Locks the ranking / share / country-set calculations in lib/markets/explorer.ts
 * against the canonical markets_sample.json. These guard the four calculation
 * fixes:
 *   - share is based on the total over ALL ranked countries (not the top-10 sum);
 *   - the ranking country set is the commodity's producing countries, so
 *     mango-only countries are not miscounted as "missing" a banana figure;
 *   - a ranked country must have a figure for EVERY selected season, so a
 *     single-season country (Nigeria, 2024 only) drops out of a 2020+2024 view.
 *
 * Run with Node's built-in test runner + native type stripping:
 *   node --test --experimental-strip-types lib/markets/explorer.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildExplorerView, type ExplorerParams, type RankingList } from './explorer.ts'

function baseParams(overrides: Partial<ExplorerParams> = {}): ExplorerParams {
  return {
    commodity: 'banana',
    seasons: ['2024'],
    annualAverage: false,
    valuationMethod: 'global',
    fillGaps: false,
    scope: 'WORLD',
    mapMeasure: 'production',
    ...overrides,
  }
}

function productionRanking(params: ExplorerParams): RankingList {
  const view = buildExplorerView(params)
  const r = view.rankings.find(x => x.measure === 'production')
  assert.ok(r, 'production ranking present')
  return r
}

const MT = 1_000_000

test('Bananas 2024 World: 41 ranked countries, 134.0 Mt all-ranked total, 72% top-10', () => {
  const r = productionRanking(baseParams())
  assert.equal(r.rankedCount, 41, 'exactly 41 producing countries ranked')
  assert.equal((r.total / MT).toFixed(1), '134.0', 'all-ranked total is 134.0 Mt (not the top-10 sum)')

  // top-10 share of the all-ranked total.
  const top10Sum = r.rows.slice(0, 10).reduce((a, row) => a + row.value, 0)
  assert.equal(Math.round((top10Sum / r.total) * 100), 72, 'top-10 is 72% of all ranked')

  // Bananas production "no figure" count is 0 — mango-only countries excluded.
  assert.equal(r.missingCount, 0, 'no banana-producing country is missing its 2024 figure')
})

test('India shows 28% for Bananas 2024 World (share of all ranked, not top-10 sum)', () => {
  const r = productionRanking(baseParams())
  const india = r.rows.find(row => row.iso3 === 'IND')
  assert.ok(india, 'India is ranked')
  assert.equal((india.value / MT).toFixed(1), '37.6', 'India = 37.6 Mt')
  assert.equal(Math.round(india.share * 100), 28, 'India share = 28% of the 134.0 Mt all-ranked total')
})

test('Mangoes 2024 World (filled): 40 ranked countries, 59.8 Mt all-ranked total', () => {
  const r = productionRanking(baseParams({ commodity: 'mango', fillGaps: true }))
  assert.equal(r.rankedCount, 40, '40 mango-producing countries resolve a 2024 figure (with fill)')
  assert.equal((r.total / MT).toFixed(1), '59.8', 'mango all-ranked total = 59.8 Mt')
  // Fill is doing the work: all but the three exact-2024 figures are filled, so
  // the displayed top-N includes forward-filled rows carrying a source season.
  assert.ok(r.rows.some(row => row.filled && row.filledFrom), 'ranked mango figures include forward-filled values')
})

test('Bananas combined 2020+2024 World: 242.0 Mt all-ranked, Nigeria not ranked', () => {
  const r = productionRanking(baseParams({ seasons: ['2020', '2024'], fillGaps: false }))
  assert.equal((r.total / MT).toFixed(1), '242.0', 'combined all-ranked total = 242.0 Mt')
  // Nigeria only reports 2024 banana production, so it fails the all-seasons rule.
  assert.ok(!r.rows.some(row => row.iso3 === 'NGA'), 'Nigeria is not among the ranked rows')
})

test('Bananas production "no figure" count is 0', () => {
  const r = productionRanking(baseParams())
  assert.equal(r.missingCount, 0)
})
