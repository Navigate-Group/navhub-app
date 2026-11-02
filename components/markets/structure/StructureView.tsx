'use client'

import { useMemo, useState } from 'react'
import { listCommodityOptions } from '@/lib/markets/explorer'
import {
  buildStructureView,
  listScopeOptions,
  type StructureCountryCard,
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

const STATUS_STYLES: Record<string, string> = {
  ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400',
  part: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  gap: 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-400',
}

function StructureCard({ card }: { card: StructureCountryCard }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{card.name}</h3>
        {card.continent && <span className="text-xs text-muted-foreground">{card.continent}</span>}
      </div>

      {card.note && <p className="mb-3 text-sm text-foreground">{card.note}</p>}

      {card.classifications.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-3">
          {card.classifications.map(c => (
            <div key={c.key} className="flex items-center gap-1.5">
              <span className="text-xs font-medium capitalize text-muted-foreground">
                {c.key.replace(/_/g, ' ')}:
              </span>
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] font-medium',
                  STATUS_STYLES[c.status] ?? 'bg-muted text-muted-foreground',
                )}
              >
                {c.detail}
              </span>
            </div>
          ))}
        </div>
      )}

      {card.breakdowns.map((b, i) => (
        <div key={i} className="mb-3 space-y-1">
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
              <span className="w-12 shrink-0 text-right text-xs tabular-nums">{(p.share * 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>
      ))}

      {card.sources.length > 0 && (
        <p className="border-t border-border pt-2 text-[11px] text-muted-foreground">
          Sources: {card.sources.map(s => s.label).join(', ')}
        </p>
      )}
    </div>
  )
}

export default function StructureView() {
  const commodities = useMemo(() => listCommodityOptions(), [])
  const scopes = useMemo(() => listScopeOptions(), [])

  const [commodity, setCommodity] = useState(commodities[0]?.id ?? 'banana')
  const [scope, setScope] = useState('WORLD')

  const view = useMemo(() => buildStructureView({ commodity, scope }), [commodity, scope])

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Farm structure</h1>
        <p className="text-sm text-muted-foreground">
          Area size, turnover, ownership, notes and sources per country for {view.commodityName}.
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

      {view.cards.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No structured farm records for {view.commodityName} in {view.scopeLabel}.
          {view.defaultGapSource && <> Expected source: {view.defaultGapSource}.</>}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {view.cards.map(card => (
            <StructureCard key={card.iso3} card={card} />
          ))}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">{view.disclaimer}</p>
    </div>
  )
}
