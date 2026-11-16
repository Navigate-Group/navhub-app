/**
 * Unit tests for the Markets settings + usage helpers (MKT-8).
 * ──────────────────────────────────────────────────────────────────────────
 * Exercises the PURE, dependency-free logic that gates admin saves and the
 * daily-cap boundary — the parts that do not touch a live database:
 *
 *   • validateMarketSettings — measures must exist, commodity must be active,
 *     ranking size must be in the 5–20 band, coverage columns must be known,
 *     alert threshold 0–100, token cap ≥ 0.
 *   • startOfDayInTimezone    — the "midnight Perth time" boundary the cap
 *     resets at (Perth is UTC+8, no DST).
 *
 * Run with: npm run test:markets (node --test --experimental-strip-types).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  validateMarketSettings,
  ALL_MEASURE_IDS,
  ALL_COMMODITY_IDS,
  DEFAULT_HEADLINE_MEASURES,
  DEFAULT_RANKING_SIZE,
} from './settings.ts'
import { startOfDayInTimezone } from './usage.ts'

// ── validateMarketSettings ──────────────────────────────────────────────────

test('validateMarketSettings accepts known measures, commodity and in-range size', () => {
  const res = validateMarketSettings({
    headlineMeasures: DEFAULT_HEADLINE_MEASURES.slice(0, 2),
    rankingSize: DEFAULT_RANKING_SIZE,
    defaultCommodity: ALL_COMMODITY_IDS[0],
    coverageColumns: [],
    alertThresholdPct: 80,
    dailyTokenCap: 100000,
  })
  assert.equal(res.ok, true)
})

test('validateMarketSettings rejects an unknown headline measure', () => {
  const res = validateMarketSettings({ headlineMeasures: ['production', 'not_a_measure'] })
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /not_a_measure/)
})

test('validateMarketSettings rejects an empty headline measure list', () => {
  const res = validateMarketSettings({ headlineMeasures: [] })
  assert.equal(res.ok, false)
})

test('validateMarketSettings rejects a ranking size outside 5–20', () => {
  assert.equal(validateMarketSettings({ rankingSize: 4 }).ok, false)
  assert.equal(validateMarketSettings({ rankingSize: 21 }).ok, false)
  assert.equal(validateMarketSettings({ rankingSize: 5 }).ok, true)
  assert.equal(validateMarketSettings({ rankingSize: 20 }).ok, true)
})

test('validateMarketSettings rejects an inactive / unknown commodity', () => {
  const res = validateMarketSettings({ defaultCommodity: 'durian_not_seeded' })
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /durian_not_seeded/)
})

test('validateMarketSettings rejects an unknown coverage column', () => {
  const res = validateMarketSettings({ coverageColumns: ['Not A Column'] })
  assert.equal(res.ok, false)
})

test('validateMarketSettings rejects an out-of-range alert threshold and negative cap', () => {
  assert.equal(validateMarketSettings({ alertThresholdPct: 101 }).ok, false)
  assert.equal(validateMarketSettings({ alertThresholdPct: -1 }).ok, false)
  assert.equal(validateMarketSettings({ dailyTokenCap: -5 }).ok, false)
  assert.equal(validateMarketSettings({ dailyTokenCap: 0 }).ok, true) // 0 = unlimited
})

test('ALL_MEASURE_IDS includes the core measures from the sample', () => {
  assert.ok(ALL_MEASURE_IDS.includes('production'))
  assert.ok(ALL_MEASURE_IDS.includes('export_value'))
})

// ── startOfDayInTimezone (Perth boundary) ───────────────────────────────────

test('startOfDayInTimezone returns local midnight for Perth (UTC+8, no DST)', () => {
  // 2024-06-15T02:00Z is 10:00 the same day in Perth → day start = 14 Jun 16:00Z.
  const t = new Date('2024-06-15T02:00:00Z')
  const sod = startOfDayInTimezone('Australia/Perth', t)
  assert.equal(sod.toISOString(), '2024-06-14T16:00:00.000Z')
})

test('startOfDayInTimezone handles an instant just after local midnight', () => {
  // 2024-06-15T17:00Z is 01:00 on 16 Jun in Perth → day start = 15 Jun 16:00Z.
  const t = new Date('2024-06-15T17:00:00Z')
  const sod = startOfDayInTimezone('Australia/Perth', t)
  assert.equal(sod.toISOString(), '2024-06-15T16:00:00.000Z')
})

test('startOfDayInTimezone falls back to the UTC day start on a bad timezone', () => {
  const t = new Date('2024-06-15T09:30:00Z')
  const sod = startOfDayInTimezone('Not/AZone', t)
  assert.equal(sod.toISOString(), '2024-06-15T00:00:00.000Z')
})
