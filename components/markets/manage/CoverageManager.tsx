'use client'

import { useEffect, useMemo, useState } from 'react'
import CrudManager, { type CrudRow, type FieldDef, type SelectOption } from './CrudManager'
import ValuationMethodsManager from './ValuationMethodsManager'
import { useToast } from './Toaster'

interface CommodityLite { id: string; name: string; seasons: string[] }
interface SourceLite { id: string; name: string }

interface PriceRow extends CrudRow {
  commodity: string; series: string; season: string; value: number; unit: string | null; source: string | null
}
interface FxRow extends CrudRow {
  pair: string; season: string; rate: number; source: string | null; note: string | null
}

const selectClass =
  'h-9 rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring'

/**
 * Data coverage curation (MKT-6): price series, FX rates and the per-commodity
 * valuation methods. Commodity + source dropdowns are populated from the live
 * (non-archived) reference data; the seasons dropdown is CONTEXT-FILTERED to the
 * selected commodity's declared seasons.
 */
export default function CoverageManager() {
  const toast = useToast()
  const [commodities, setCommodities] = useState<CommodityLite[]>([])
  const [sources, setSources] = useState<SourceLite[]>([])
  const [commodity, setCommodity] = useState('')

  useEffect(() => {
    const run = async () => {
      try {
        const [cRes, sRes] = await Promise.all([
          fetch('/api/markets/manage/commodities', { cache: 'no-store' }),
          fetch('/api/markets/manage/sources', { cache: 'no-store' }),
        ])
        if (cRes.ok) {
          const j = await cRes.json()
          const rows = (j.rows ?? []) as CommodityLite[]
          setCommodities(rows)
          if (rows[0]) setCommodity(rows[0].id)
        }
        if (sRes.ok) setSources(((await sRes.json()).rows ?? []) as SourceLite[])
      } catch (e) {
        toast.error((e as Error).message)
      }
    }
    void run()
  }, [toast])

  const commodityOptions: SelectOption[] = useMemo(
    () => commodities.map(c => ({ value: c.id, label: c.name })), [commodities])
  const sourceOptions: SelectOption[] = useMemo(
    () => sources.map(s => ({ value: s.id, label: s.name })), [sources])
  const selectedSeasons: SelectOption[] = useMemo(() => {
    const c = commodities.find(x => x.id === commodity)
    return (c?.seasons ?? []).map(s => ({ value: s, label: s }))
  }, [commodities, commodity])

  const priceFields: FieldDef<PriceRow>[] = [
    { name: 'commodity', label: 'Commodity', type: 'select', required: true, options: commodityOptions },
    { name: 'series', label: 'Series', required: true, placeholder: 'wb_banana_us' },
    { name: 'season', label: 'Season', type: 'select', required: true, options: selectedSeasons },
    { name: 'value', label: 'Value', type: 'number', required: true },
    { name: 'unit', label: 'Unit', placeholder: 'USD/t' },
    { name: 'source', label: 'Source', type: 'select', options: sourceOptions },
  ]

  const fxFields: FieldDef<FxRow>[] = [
    { name: 'pair', label: 'Pair', required: true, placeholder: 'USD per AUD' },
    { name: 'season', label: 'Season', type: 'select', required: true, options: selectedSeasons },
    { name: 'rate', label: 'Rate', type: 'number', required: true },
    { name: 'source', label: 'Source', type: 'select', options: sourceOptions },
    { name: 'note', label: 'Note', placeholder: '', hideInTable: true },
  ]

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          <span>Commodity context (seasons &amp; valuation methods)</span>
          <select className={selectClass} value={commodity} onChange={e => setCommodity(e.target.value)}>
            {commodities.length === 0 && <option value="">No commodities</option>}
            {commodities.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <p className="text-xs text-muted-foreground">
          The seasons dropdown and valuation methods below are filtered to this commodity.
        </p>
      </div>

      <CrudManager<PriceRow>
        key={`prices-${commodity}`}
        title="Price series"
        description="Price-series observations used by valuation methods."
        endpoint="/api/markets/manage/prices"
        itemNoun="price"
        fields={priceFields}
        query={commodity ? `commodity=${encodeURIComponent(commodity)}` : undefined}
      />

      <CrudManager<FxRow>
        title="FX rates"
        description="Foreign-exchange rates used to convert local producer prices to USD."
        endpoint="/api/markets/manage/fx"
        itemNoun="FX rate"
        fields={fxFields}
      />

      {commodity && <ValuationMethodsManager key={`vm-${commodity}`} commodity={commodity} />}
    </div>
  )
}
