'use client'

import { useMemo, useState, useRef, useEffect } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  type CommodityOption,
  type ScopeOption,
  type CommodityMeta,
  getCommodityMeta,
  getCommodityValuationMethods,
  countriesReportingInSeason,
} from '@/lib/markets/explorer'

export interface ControlState {
  commodity: string
  seasons: string[]
  annualAverage: boolean
  valuationMethod: string
  fillGaps: boolean
  scope: string
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      <span>{label}</span>
      {children}
    </label>
  )
}

const selectClass =
  'h-9 rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring'

/** Multi-select season dropdown with per-season country counts + shortcuts. */
function SeasonMultiSelect({
  commodity,
  seasons,
  selected,
  onChange,
}: {
  commodity: string
  seasons: string[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const counts = useMemo(
    () =>
      Object.fromEntries(
        seasons.map(s => [s, countriesReportingInSeason(commodity, s)]),
      ) as Record<string, number>,
    [commodity, seasons],
  )

  const toggle = (s: string) => {
    const set = new Set(selected)
    if (set.has(s)) set.delete(s)
    else set.add(s)
    // Keep season order stable (oldest → newest).
    onChange(seasons.filter(x => set.has(x)))
  }

  const label =
    selected.length === 0
      ? 'None'
      : selected.length === seasons.length
        ? 'All seasons'
        : selected.length === 1
          ? selected[0]
          : `${selected.length} seasons`

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={cn(selectClass, 'flex w-full items-center justify-between gap-2 min-w-[8rem]')}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{label}</span>
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-56 rounded-md border border-border bg-popover p-1 shadow-md">
          <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => onChange([seasons[seasons.length - 1]])}
            >
              Latest only
            </button>
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => onChange(seasons.slice())}
            >
              Select all
            </button>
          </div>
          <div className="my-1 h-px bg-border" />
          {seasons.map(s => {
            const on = selected.includes(s)
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggle(s)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                role="option"
                aria-selected={on}
              >
                <span
                  className={cn(
                    'flex h-4 w-4 items-center justify-center rounded border',
                    on ? 'border-primary bg-primary text-white' : 'border-input',
                  )}
                >
                  {on && <Check className="h-3 w-3" />}
                </span>
                <span className="flex-1">{s}</span>
                <span className="text-xs text-muted-foreground">
                  {counts[s]} countries
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function ControlRow({
  commodities,
  scopes,
  state,
  onChange,
}: {
  commodities: CommodityOption[]
  scopes: ScopeOption[]
  state: ControlState
  onChange: (next: Partial<ControlState>) => void
}) {
  const meta: CommodityMeta | null = useMemo(
    () => getCommodityMeta(state.commodity),
    [state.commodity],
  )
  const methods = useMemo(
    () => getCommodityValuationMethods(state.commodity),
    [state.commodity],
  )
  const seasons = meta?.seasons ?? []
  const multiSeason = state.seasons.length > 1

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
      <Field label="Commodity">
        <select
          className={selectClass}
          value={state.commodity}
          onChange={e => onChange({ commodity: e.target.value })}
        >
          {commodities.map(c => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Season">
        <SeasonMultiSelect
          commodity={state.commodity}
          seasons={seasons}
          selected={state.seasons}
          onChange={next => onChange({ seasons: next.length ? next : [seasons[seasons.length - 1]] })}
        />
      </Field>

      {multiSeason && (
        <Field label="Across seasons">
          <select
            className={selectClass}
            value={state.annualAverage ? 'avg' : 'total'}
            onChange={e => onChange({ annualAverage: e.target.value === 'avg' })}
          >
            <option value="total">Total</option>
            <option value="avg">Annual average</option>
          </select>
        </Field>
      )}

      <Field label="Valuation method">
        <select
          className={selectClass}
          value={state.valuationMethod}
          onChange={e => onChange({ valuationMethod: e.target.value })}
        >
          {methods.map(m => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Scope">
        <select
          className={selectClass}
          value={state.scope}
          onChange={e => onChange({ scope: e.target.value })}
        >
          {scopes.map(s => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </Field>

      <label className="flex h-9 cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-input accent-[hsl(var(--primary))]"
          checked={state.fillGaps}
          onChange={e => onChange({ fillGaps: e.target.checked })}
        />
        <span>Fill gaps</span>
      </label>
    </div>
  )
}
