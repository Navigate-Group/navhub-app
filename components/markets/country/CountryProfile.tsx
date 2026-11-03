'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { listCommodityOptions, getCommodityValuationMethods, buildExplorerView, type ExplorerParams } from '@/lib/markets/explorer'
import {
  buildCountryProfile,
  listProducerCountries,
  getDefaultCountry,
  type CountryMeasureCell,
} from '@/lib/markets/views'
import { formatMeasure, formatCompact } from '@/components/markets/overview/format'
import AnalystPanel from '@/components/markets/analyst/AnalystPanel'
import type { FallbackContext } from '@/lib/markets/analyst-fallback'
import { cn } from '@/lib/utils'

const selectClass =
  'h-9 rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      <span>{label}</span>
      {children}
    </label>
  )
}

/** Production-by-season line chart. */
function ProductionChart({
  points,
}: {
  points: Array<{ season: string; value: number | null; filled: boolean }>
}) {
  const data = points.map(p => ({ season: p.season, value: p.value, filled: p.filled }))
  const hasData = data.some(d => d.value != null)
  if (!hasData) {
    return (
      <div className="flex h-48 items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
        No production series for this country.
      </div>
    )
  }
  return (
    <div className="h-48 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} />
          <XAxis
            dataKey="season"
            tick={{ fontSize: 11, fill: 'currentColor', opacity: 0.5 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: 'currentColor', opacity: 0.5 }}
            axisLine={false}
            tickLine={false}
            width={48}
            tickFormatter={v => formatCompact(v as number)}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0) return null
              const p = payload[0].payload as { value: number | null; filled: boolean }
              return (
                <div className="rounded-md border border-border bg-background px-3 py-2 text-xs shadow-md">
                  <p className="font-medium text-foreground">{label}</p>
                  <p className="text-primary tabular-nums">
                    {formatMeasure(p.value, 'mass')}
                    {p.filled && <span className="text-muted-foreground"> (filled)</span>}
                  </p>
                </div>
              )
            }}
          />
          <Line
            type="monotone"
            dataKey="value"
            connectNulls
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            dot={{ r: 3, fill: 'hsl(var(--primary))', strokeWidth: 0 }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

/** A single measure tile with value, rank and a season/filled flag. */
function MeasureTile({ cell }: { cell: CountryMeasureCell }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{cell.label}</p>
        {cell.rank != null && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            #{cell.rank} of {cell.rankOf}
          </span>
        )}
      </div>
      <p className="mt-1 text-xl font-bold tabular-nums">{formatMeasure(cell.value, cell.format)}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {cell.filled && cell.filledFrom && (
          <span
            className="rounded bg-amber-100 px-1.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
            title={`Forward-filled from ${cell.filledFrom}`}
          >
            filled from {cell.filledFrom}
          </span>
        )}
        {cell.source && <span className="text-[10px] text-muted-foreground">{cell.source}</span>}
      </div>
      {cell.caption && <p className="mt-1 text-[11px] text-muted-foreground">{cell.caption}</p>}
    </div>
  )
}

const STATUS_STYLES: Record<string, string> = {
  ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400',
  part: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  gap: 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-400',
}

function OwnershipChip({ status, label }: { status: string; label: string }) {
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium capitalize', STATUS_STYLES[status] ?? 'bg-muted text-muted-foreground')}>
      {label}
    </span>
  )
}

export default function CountryProfile({ initialIso3 }: { initialIso3?: string }) {
  const router = useRouter()
  const commodities = useMemo(() => listCommodityOptions(), [])

  const [commodity, setCommodity] = useState(commodities[0]?.id ?? 'banana')
  const producers = useMemo(() => listProducerCountries(commodity), [commodity])
  const [iso3, setIso3] = useState(
    initialIso3 && producers.some(p => p.iso3 === initialIso3)
      ? initialIso3
      : getDefaultCountry(commodity),
  )
  const methods = useMemo(() => getCommodityValuationMethods(commodity), [commodity])
  const [valuationMethod, setValuationMethod] = useState(methods[0]?.id ?? '')
  const [season, setSeason] = useState<string | undefined>(undefined)

  const onCommodityChange = (next: string) => {
    setCommodity(next)
    const nextProducers = listProducerCountries(next)
    const keep = nextProducers.some(p => p.iso3 === iso3) ? iso3 : getDefaultCountry(next)
    setIso3(keep)
    const nextMethods = getCommodityValuationMethods(next)
    setValuationMethod(nextMethods[0]?.id ?? '')
    setSeason(undefined)
  }

  const view = useMemo(
    () => buildCountryProfile({ commodity, iso3, season, valuationMethod }),
    [commodity, iso3, season, valuationMethod],
  )

  // The Agent Analysis panel reads an ExplorerView for its fallback facts and
  // sends the view params to the chat API. On the Country tab we give it the
  // WORLD view for the current commodity/season so the analyst can place the
  // country inside the global market it's a part of.
  const analystParams: ExplorerParams = useMemo(
    () => ({
      commodity,
      seasons: view?.season ? [view.season] : [],
      annualAverage: false,
      valuationMethod,
      fillGaps: true,
      scope: 'WORLD',
      mapMeasure: 'production',
    }),
    [commodity, valuationMethod, view?.season],
  )
  const analystView = useMemo(() => buildExplorerView(analystParams), [analystParams])
  const fallbackContext: FallbackContext = useMemo(() => {
    const parts = view?.structure?.breakdowns?.[0]?.parts ?? []
    const top = parts.length ? parts.reduce((a, b) => (b.share > a.share ? b : a)) : null
    return {
      scopeLabel: view?.name,
      farmStructure: top ? { label: top.label, share: top.share } : null,
    }
  }, [view])

  if (!view) {
    return <p className="text-sm text-muted-foreground">No data for this country.</p>
  }

  return (
    <div className="mx-auto max-w-7xl flex flex-col gap-4 lg:flex-row lg:items-start">
      <div className="min-w-0 flex-1 space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{view.name}</h1>
        <p className="text-sm text-muted-foreground">
          {view.commodityName} profile · {view.continent ?? 'Region unassigned'}
          {view.zones.length > 0 && <> · {view.zones.join(', ')}</>}
          {view.m49 && <span className="text-muted-foreground/70"> · M49 {view.m49}</span>}
        </p>
      </div>

      {/* Control row */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
        <Field label="Commodity">
          <select className={selectClass} value={commodity} onChange={e => onCommodityChange(e.target.value)}>
            {commodities.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Country">
          <select
            className={selectClass}
            value={iso3}
            onChange={e => {
              setIso3(e.target.value)
              router.replace(`/markets/country/${e.target.value}`)
            }}
          >
            {producers.map(p => (
              <option key={p.iso3} value={p.iso3}>{p.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Season">
          <select className={selectClass} value={view.season} onChange={e => setSeason(e.target.value)}>
            {view.seasons.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Valuation method">
          <select className={selectClass} value={valuationMethod} onChange={e => setValuationMethod(e.target.value)}>
            {methods.map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </Field>
      </div>

      {/* Measures */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {view.measures.map(m => (
          <MeasureTile key={m.measure} cell={m} />
        ))}
      </div>

      {/* Production by season */}
      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">Production by season</h2>
        <ProductionChart points={view.productionBySeason} />
      </div>

      {/* Regions */}
      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">Regions</h2>
        {view.regions.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No seeded sub-national regions.
            {view.regionsGapSource && <> Expected source: {view.regionsGapSource}.</>}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {view.regions.map(r => (
              <span key={r.iso3} className="rounded-md border border-border bg-background px-2.5 py-1 text-xs">
                {r.name}
                {r.regionType && <span className="text-muted-foreground/70"> · {r.regionType}</span>}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Farm structure card */}
      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">Farm structure</h2>
        {view.structure === null ? (
          <p className="text-xs text-muted-foreground">
            No structured farm record for {view.name}.
            {view.structureGapSource && <> Expected source: {view.structureGapSource}.</>}
          </p>
        ) : (
          <div className="space-y-3">
            {view.structure.note && <p className="text-sm text-foreground">{view.structure.note}</p>}
            {view.structure.classifications.length > 0 && (
              <div className="flex flex-wrap gap-3">
                {view.structure.classifications.map(c => (
                  <div key={c.key} className="flex items-center gap-1.5">
                    <span className="text-xs font-medium capitalize text-muted-foreground">
                      {c.key.replace(/_/g, ' ')}:
                    </span>
                    <OwnershipChip status={c.status} label={c.detail} />
                  </div>
                ))}
              </div>
            )}
            {view.structure.breakdowns.map((b, i) => (
              <div key={i} className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">{b.label}</p>
                {b.parts.map((p, j) => (
                  <div key={j} className="flex items-center gap-2 text-sm">
                    <div className="relative h-4 flex-1 overflow-hidden rounded bg-muted/50">
                      <div
                        className="absolute inset-y-0 left-0 rounded bg-primary/70"
                        style={{ width: `${Math.max(2, p.share * 100)}%` }}
                      />
                    </div>
                    <span className="w-40 shrink-0 truncate text-xs" title={p.label}>{p.label}</span>
                    <span className="w-12 shrink-0 text-right text-xs tabular-nums">
                      {(p.share * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
              </div>
            ))}
            {view.structure.sources.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                Sources: {view.structure.sources.map(s => s.label).join(', ')}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Operators */}
      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">Operators</h2>
        {view.operators.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No seeded operators for {view.name}.
            {view.operatorsGapSource && <> Expected source: {view.operatorsGapSource}.</>}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">Name</th>
                  <th className="py-1.5 pr-3 font-medium">Region</th>
                  <th className="py-1.5 pr-3 font-medium">Role</th>
                  <th className="py-1.5 pr-3 font-medium">Ownership</th>
                  <th className="py-1.5 pr-3 font-medium">Size</th>
                  <th className="py-1.5 pr-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {view.operators.map((o, i) => (
                  <tr key={i} className="border-b border-border/50">
                    <td className="py-1.5 pr-3 font-medium">{o.name}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{o.region ?? '—'}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{o.role ?? '—'}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{o.ownership ?? '—'}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{o.size ?? '—'}</td>
                    <td className="py-1.5 pr-3">
                      {o.status && (
                        <span
                          className={cn(
                            'rounded px-1.5 py-0.5 text-[10px] font-medium',
                            o.status === 'Verified'
                              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400'
                              : 'bg-muted text-muted-foreground',
                          )}
                        >
                          {o.status}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">{view.disclaimer}</p>

      <p className="text-xs">
        <Link href="/markets" className="text-primary hover:underline">← Back to Overview</Link>
      </p>
      </div>

      <AnalystPanel
        view={analystView}
        viewParams={analystParams}
        fallbackContext={fallbackContext}
        scopeLabel={view.name}
      />
    </div>
  )
}
