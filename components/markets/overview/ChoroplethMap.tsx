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
import topology from '@/lib/markets/vendor/countries-110m.json'
import {
  decodeCountries,
  makeProjection,
  featurePath,
  normaliseM49,
  type Topology,
  type CountryFeature,
} from '@/lib/markets/vendor/geo'

/**
 * Geographic world choropleth. Country geometry comes from the vendored
 * world-atlas 110m topology (lib/markets/vendor), decoded to GeoJSON polygons
 * and projected with an equirectangular projection. Each country path is joined
 * to the explorer's per-country figures by M49 code (leading zeros stripped on
 * both sides, so 036 / 076 etc. match) and shaded by a six-class quantile
 * scale, with distinct 'no data' and 'outside scope' fills. Hover shows the
 * figure; clicking an in-scope country drills into its profile.
 */

// Six quantile classes, filled from the CSS data-viz ramp tokens so the map
// renders correctly in both light and dark themes.
const BUCKET_FILLS = [
  'hsl(var(--map-1))',
  'hsl(var(--map-2))',
  'hsl(var(--map-3))',
  'hsl(var(--map-4))',
  'hsl(var(--map-5))',
  'hsl(var(--map-6))',
]
const BUCKET_COUNT = BUCKET_FILLS.length
const NO_DATA_FILL = 'hsl(var(--map-nodata))'
const OUT_SCOPE_FILL = 'hsl(var(--map-outscope))'

const VIEW_W = 960
const VIEW_H = 480

/** Equal-count quantile thresholds (BUCKET_COUNT − 1 cut points). */
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

  // Decode + project the country geometry once (static data).
  const features = useMemo<Array<CountryFeature & { d: string }>>(() => {
    const project = makeProjection({ width: VIEW_W, height: VIEW_H })
    return decodeCountries(topology as unknown as Topology, 'countries').map(f => ({
      ...f,
      d: featurePath(f, project),
    }))
  }, [])

  // Join country figures by normalised M49.
  const byM49 = useMemo(() => {
    const m = new Map<string, MapCountry>()
    for (const c of map) m.set(normaliseM49(c.m49), c)
    return m
  }, [map])

  const inScopeValues = useMemo(
    () => map.filter(c => c.state === 'in-scope' && c.value != null).map(c => c.value as number),
    [map],
  )
  const thresholds = useMemo(() => quantileThresholds(inScopeValues), [inScopeValues])
  const dataRange = useMemo(() => {
    if (inScopeValues.length === 0) return null
    return { min: Math.min(...inScopeValues), max: Math.max(...inScopeValues) }
  }, [inScopeValues])

  const fillFor = (c: MapCountry | undefined): string => {
    if (!c || c.state === 'outside-scope') return OUT_SCOPE_FILL
    if (c.state === 'no-data' || c.value == null) return NO_DATA_FILL
    return BUCKET_FILLS[bucketOf(c.value, thresholds)]
  }

  // Legend swatch labels: the upper bound of each class (except the last).
  const legendClasses = useMemo(
    () =>
      BUCKET_FILLS.map((fill, i) => ({
        fill,
        upper: i < thresholds.length ? thresholds[i] : null,
      })),
    [thresholds],
  )

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

      {/* Geographic SVG map */}
      <div className="relative">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="h-auto w-full"
          role="img"
          aria-label={`World choropleth of ${measureLabel}`}
          preserveAspectRatio="xMidYMid meet"
        >
          <g>
            {features.map(f => {
              const c = byM49.get(normaliseM49(f.id))
              const clickable = !!c && c.state !== 'outside-scope'
              const active = !!hover && c?.iso3 === hover.iso3
              return (
                <path
                  key={f.id || f.name}
                  d={f.d}
                  fill={fillFor(c)}
                  stroke="hsl(var(--border))"
                  strokeWidth={active ? 1.2 : 0.4}
                  className={cn(
                    'transition-[stroke-width,opacity]',
                    clickable ? 'cursor-pointer hover:opacity-80' : 'cursor-default',
                  )}
                  onMouseEnter={() => c && setHover(c)}
                  onMouseLeave={() => setHover(h => (h?.iso3 === c?.iso3 ? null : h))}
                  onClick={() => clickable && c && router.push(`/markets/country/${c.iso3}`)}
                >
                  {c && (
                    <title>
                      {c.name}
                      {c.state === 'outside-scope'
                        ? ' — outside current scope'
                        : c.value == null
                          ? ' — no data'
                          : ` — ${measureLabel}: ${formatMeasure(c.value, measureFormat)}`}
                    </title>
                  )}
                </path>
              )
            })}
          </g>
        </svg>

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

      {/* Six-class legend + state keys */}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <span>Low</span>
          <div className="flex items-end">
            {legendClasses.map((cls, i) => (
              <span key={i} className="flex flex-col items-center">
                <span
                  className="h-3 w-6 border border-border/40"
                  style={{ backgroundColor: cls.fill }}
                />
                {cls.upper != null && (
                  <span className="mt-0.5 text-[9px] tabular-nums text-muted-foreground/70">
                    {formatMeasure(cls.upper, measureFormat)}
                  </span>
                )}
              </span>
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
          <span
            className="h-3 w-6 rounded-sm border border-border"
            style={{ backgroundColor: NO_DATA_FILL }}
          />
          <span>No data</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="h-3 w-6 rounded-sm border border-border/50"
            style={{ backgroundColor: OUT_SCOPE_FILL }}
          />
          <span>Outside scope</span>
        </div>
      </div>
    </div>
  )
}
