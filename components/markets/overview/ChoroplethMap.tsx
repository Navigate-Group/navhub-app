'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  type MapCountry,
  type ExplorerMeasure,
  MAP_MEASURES,
} from '@/lib/markets/explorer'
import { formatMeasure } from './format'

/**
 * A tile-grid choropleth. Every seeded country is rendered as a tile keyed by
 * its M49 code, grouped by continent, and shaded by a quantile scale of the
 * current measure. A geographic SVG would need country path geometry that is
 * not available in this repo (no map library / topojson); the tile-grid is a
 * recognised choropleth style that keeps all the required behaviour — M49 key,
 * quantile legend, hover tooltip, click drill-down and distinct 'no data' /
 * 'outside scope' states.
 */

// Quantile buckets: light → dark. Uses the Markets primary hue for continuity.
const BUCKET_COLORS = [
  'hsl(var(--primary) / 0.15)',
  'hsl(var(--primary) / 0.35)',
  'hsl(var(--primary) / 0.55)',
  'hsl(var(--primary) / 0.75)',
  'hsl(var(--primary) / 0.95)',
]
const BUCKET_COUNT = BUCKET_COLORS.length

const CONTINENT_ORDER = [
  'North & Central America',
  'South America',
  'Europe',
  'Africa',
  'Asia',
  'Oceania',
]

/** Compute quantile thresholds for the in-scope values. */
function quantileThresholds(values: number[]): number[] {
  const sorted = values.slice().sort((a, b) => a - b)
  if (sorted.length === 0) return []
  const thresholds: number[] = []
  for (let i = 1; i < BUCKET_COUNT; i++) {
    const q = i / BUCKET_COUNT
    const idx = Math.floor(q * (sorted.length - 1))
    thresholds.push(sorted[idx])
  }
  return thresholds
}

function bucketOf(value: number, thresholds: number[]): number {
  let b = 0
  for (const t of thresholds) {
    if (value > t) b++
    else break
  }
  return Math.min(b, BUCKET_COUNT - 1)
}

export default function ChoroplethMap({
  map,
  measure,
  measureLabel,
  measureFormat,
  measureLabelsById,
  onMeasureChange,
}: {
  map: MapCountry[]
  measure: ExplorerMeasure
  measureLabel: string
  measureFormat: string
  measureLabelsById: Record<ExplorerMeasure, string>
  onMeasureChange: (m: ExplorerMeasure) => void
}) {
  const router = useRouter()
  const [hover, setHover] = useState<MapCountry | null>(null)

  const inScopeValues = useMemo(
    () => map.filter(c => c.state === 'in-scope' && c.value != null).map(c => c.value as number),
    [map],
  )
  const thresholds = useMemo(() => quantileThresholds(inScopeValues), [inScopeValues])
  const dataRange = useMemo(() => {
    if (inScopeValues.length === 0) return null
    return { min: Math.min(...inScopeValues), max: Math.max(...inScopeValues) }
  }, [inScopeValues])

  const byContinent = useMemo(() => {
    const groups: Record<string, MapCountry[]> = {}
    for (const c of map) {
      const key = c.continent ?? 'Other'
      ;(groups[key] = groups[key] ?? []).push(c)
    }
    for (const k of Object.keys(groups)) {
      groups[k].sort((a, b) => a.name.localeCompare(b.name))
    }
    return groups
  }, [map])

  const orderedContinents = useMemo(() => {
    const present = Object.keys(byContinent)
    const ordered = CONTINENT_ORDER.filter(c => present.includes(c))
    const extra = present.filter(c => !CONTINENT_ORDER.includes(c)).sort()
    return [...ordered, ...extra]
  }, [byContinent])

  const tileColor = (c: MapCountry): string => {
    if (c.state === 'outside-scope') return 'hsl(var(--muted))'
    if (c.state === 'no-data' || c.value == null) return 'hsl(var(--muted) / 0.4)'
    return BUCKET_COLORS[bucketOf(c.value, thresholds)]
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      {/* Header: title + measure switcher */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Map — {measureLabel}</h2>
          <p className="text-xs text-muted-foreground">
            Shaded by quantile. Click a country for its profile.
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {MAP_MEASURES.map(m => (
            <button
              key={m}
              type="button"
              onClick={() => onMeasureChange(m)}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                m === measure
                  ? 'border-primary bg-primary text-white'
                  : 'border-input bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {measureLabelsById[m]}
            </button>
          ))}
        </div>
      </div>

      {/* Tile grid, grouped by continent */}
      <div className="relative">
        <div className="space-y-3">
          {orderedContinents.map(cont => (
            <div key={cont}>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {cont}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {byContinent[cont].map(c => {
                  const clickable = c.state !== 'outside-scope'
                  return (
                    <button
                      key={c.iso3}
                      type="button"
                      data-m49={c.m49}
                      disabled={!clickable}
                      onMouseEnter={() => setHover(c)}
                      onMouseLeave={() => setHover(h => (h?.iso3 === c.iso3 ? null : h))}
                      onFocus={() => setHover(c)}
                      onClick={() => clickable && router.push(`/markets/country/${c.iso3}`)}
                      title={`${c.name} (M49 ${c.m49})`}
                      className={cn(
                        'flex h-10 w-14 flex-col items-center justify-center rounded border text-[10px] font-medium leading-tight transition-transform',
                        clickable ? 'cursor-pointer hover:scale-105 hover:ring-1 hover:ring-primary' : 'cursor-default opacity-60',
                        c.state === 'no-data' && 'border-dashed',
                        c.state === 'outside-scope' && 'border-border/50',
                      )}
                      style={{ backgroundColor: tileColor(c) }}
                    >
                      <span
                        className={cn(
                          c.state === 'in-scope' && bucketOf(c.value as number, thresholds) >= 3
                            ? 'text-white'
                            : 'text-foreground',
                        )}
                      >
                        {c.iso3}
                      </span>
                      {c.state === 'no-data' && (
                        <span className="text-[8px] text-muted-foreground">no data</span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Hover tooltip */}
        {hover && (
          <div className="pointer-events-none absolute right-2 top-2 z-20 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
            <p className="font-semibold">{hover.name}</p>
            {hover.state === 'outside-scope' ? (
              <p className="text-muted-foreground">Outside current scope</p>
            ) : hover.value == null ? (
              <p className="text-muted-foreground">No data</p>
            ) : (
              <p className="tabular-nums">
                {measureLabel}: {formatMeasure(hover.value, measureFormat)}
                {hover.filled && hover.filledFrom && (
                  <span className="text-muted-foreground"> (filled from {hover.filledFrom})</span>
                )}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Quantile legend + state keys */}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <span>Low</span>
          <div className="flex">
            {BUCKET_COLORS.map((col, i) => (
              <span
                key={i}
                className="h-3 w-5 border border-border/40"
                style={{ backgroundColor: col }}
              />
            ))}
          </div>
          <span>High</span>
          {dataRange && (
            <span className="ml-1 text-muted-foreground/70">
              ({formatMeasure(dataRange.min, measureFormat)} – {formatMeasure(dataRange.max, measureFormat)})
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-3 w-5 rounded-sm border border-dashed border-border" style={{ backgroundColor: 'hsl(var(--muted) / 0.4)' }} />
          <span>No data</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-3 w-5 rounded-sm border border-border/50" style={{ backgroundColor: 'hsl(var(--muted))' }} />
          <span>Outside scope</span>
        </div>
      </div>
    </div>
  )
}
