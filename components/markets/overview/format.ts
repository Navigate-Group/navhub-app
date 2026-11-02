/**
 * Display formatting for Markets Explorer figures (MKT-3).
 * Formats mirror the `measures[].format` tags in markets_sample.json
 * (mass → tonnes, usd → dollars, pct → percentage, area → hectares).
 */

const COMPACT = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

const USD_COMPACT = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
  style: 'currency',
  currency: 'USD',
})

const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

/** Format a value for a measure `format` tag. Returns '—' for null/undefined. */
export function formatMeasure(value: number | null | undefined, format: string): string {
  if (value == null || Number.isNaN(value)) return '—'
  switch (format) {
    case 'usd':
      return USD_COMPACT.format(value)
    case 'pct':
      return `${(value * 100).toFixed(1)}%`
    case 'yield':
      return `${value.toFixed(1)} t/ha`
    case 'mass':
      return `${COMPACT.format(value)} t`
    case 'area':
      return `${COMPACT.format(value)} ha`
    default:
      return COMPACT.format(value)
  }
}

/** A plain compact number (no unit) for axis/tooltip secondary text. */
export function formatCompact(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—'
  return COMPACT.format(value)
}

/** Integer with grouping (country counts etc). */
export function formatInt(value: number): string {
  return INT.format(value)
}

/** A 0–1 fraction as a one-decimal percentage. */
export function formatShare(fraction: number | null | undefined): string {
  if (fraction == null || Number.isNaN(fraction)) return '—'
  return `${(fraction * 100).toFixed(1)}%`
}
