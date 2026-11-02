'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { listCommodityOptions } from '@/lib/markets/explorer'
import {
  buildCoverageView,
  listScopeOptions,
  type CoverageCell,
} from '@/lib/markets/views'
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

const STATUS: Record<CoverageCell['status'], { cls: string; label: string }> = {
  have: { cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400', label: 'Have' },
  partial: { cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400', label: 'Partial' },
  gap: { cls: 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-400', label: 'Gap' },
}

function StatusChip({ cell }: { cell: CoverageCell }) {
  const s = STATUS[cell.status]
  const text =
    cell.status === 'partial' && cell.latestSeason
      ? cell.latestSeason
      : cell.detail ?? s.label
  return (
    <span
      className={cn('inline-block rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums', s.cls)}
      title={
        cell.status === 'partial' && cell.latestSeason
          ? `Partial — latest season ${cell.latestSeason}`
          : s.label
      }
    >
      {text}
    </span>
  )
}

export default function CoverageView() {
  const commodities = useMemo(() => listCommodityOptions(), [])
  const scopes = useMemo(() => listScopeOptions(), [])

  const [commodity, setCommodity] = useState(commodities[0]?.id ?? 'banana')
  const [scope, setScope] = useState('WORLD')

  const view = useMemo(() => buildCoverageView({ commodity, scope }), [commodity, scope])

  // Configurable columns: viewers can show/hide any dimension.
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const toggle = (label: string) =>
    setHidden(prev => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  const visibleDims = view.dimensions.filter(d => !hidden.has(d.label))

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Data coverage</h1>
        <p className="text-sm text-muted-foreground">
          The largest {view.topN} {view.commodityName} producers by production ({view.season}) and what we hold for each.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
        <Field label="Commodity">
          <select className={selectClass} value={commodity} onChange={e => setCommodity(e.target.value)}>
            {commodities.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Scope">
          <select className={selectClass} value={scope} onChange={e => setScope(e.target.value)}>
            {scopes.map(s => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </Field>
      </div>

      {/* Column toggles */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
        <span className="text-xs font-medium text-muted-foreground">Columns:</span>
        {view.dimensions.map(d => {
          const on = !hidden.has(d.label)
          return (
            <button
              key={d.label}
              type="button"
              onClick={() => toggle(d.label)}
              className={cn(
                'rounded-md border px-2 py-1 text-xs font-medium transition-colors',
                on
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-input bg-background text-muted-foreground hover:bg-accent',
              )}
              aria-pressed={on}
            >
              {d.label}
            </button>
          )
        })}
      </div>

      {/* Coverage table */}
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">Country</th>
              {visibleDims.map(d => (
                <th key={d.label} className="px-3 py-2 font-medium">{d.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row, i) => (
              <tr key={row.iso3} className="border-b border-border/50 last:border-0">
                <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">{i + 1}</td>
                <td className="px-3 py-2 font-medium">
                  <Link href={`/markets/country/${row.iso3}`} className="hover:underline">
                    {row.name}
                  </Link>
                </td>
                {visibleDims.map(dim => {
                  const cell = row.cells.find(c => c.label === dim.label)
                  return (
                    <td key={dim.label} className="px-3 py-2">
                      {cell ? <StatusChip cell={cell} /> : <span className="text-muted-foreground">—</span>}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className={cn('h-3 w-5 rounded', STATUS.have.cls)} /> Have
        </span>
        <span className="flex items-center gap-1.5">
          <span className={cn('h-3 w-5 rounded', STATUS.partial.cls)} /> Partial (shows latest season)
        </span>
        <span className="flex items-center gap-1.5">
          <span className={cn('h-3 w-5 rounded', STATUS.gap.cls)} /> Gap
        </span>
      </div>

      <p className="text-[11px] text-muted-foreground">{view.disclaimer}</p>
    </div>
  )
}
