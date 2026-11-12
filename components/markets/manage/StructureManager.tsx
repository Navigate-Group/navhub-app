'use client'

import { useEffect, useMemo, useState } from 'react'
import CrudManager, { type CrudRow, type FieldDef, type SelectOption } from './CrudManager'
import { useToast } from './Toaster'

interface CommodityLite { id: string; name: string }
interface GeoLite { id: string; name: string; level: string }

interface StructureRow extends CrudRow {
  commodity: string; geo: string; note: string | null
}

const selectClass =
  'h-9 rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring'

/**
 * Farm-structure curation (MKT-6): per-commodity, per-geography notes and
 * classifications. The commodity + geo dropdowns are populated from live
 * reference data; the table is filtered to the selected commodity.
 */
export default function StructureManager() {
  const toast = useToast()
  const [commodities, setCommodities] = useState<CommodityLite[]>([])
  const [geos, setGeos] = useState<GeoLite[]>([])
  const [commodity, setCommodity] = useState('')

  useEffect(() => {
    const run = async () => {
      try {
        const [cRes, gRes] = await Promise.all([
          fetch('/api/markets/manage/commodities', { cache: 'no-store' }),
          fetch('/api/markets/manage/geo-units', { cache: 'no-store' }),
        ])
        if (cRes.ok) {
          const rows = ((await cRes.json()).rows ?? []) as CommodityLite[]
          setCommodities(rows)
          if (rows[0]) setCommodity(rows[0].id)
        }
        if (gRes.ok) setGeos(((await gRes.json()).rows ?? []) as GeoLite[])
      } catch (e) {
        toast.error((e as Error).message)
      }
    }
    void run()
  }, [toast])

  const commodityOptions: SelectOption[] = useMemo(
    () => commodities.map(c => ({ value: c.id, label: c.name })), [commodities])
  const geoOptions: SelectOption[] = useMemo(
    () => geos.map(g => ({ value: g.id, label: `${g.name} (${g.id})` })), [geos])

  const fields: FieldDef<StructureRow>[] = [
    { name: 'commodity', label: 'Commodity', type: 'select', required: true, options: commodityOptions },
    { name: 'geo', label: 'Geography', type: 'select', required: true, options: geoOptions },
    { name: 'note', label: 'Note', type: 'textarea', placeholder: 'Farm structure note…' },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          <span>Commodity</span>
          <select className={selectClass} value={commodity} onChange={e => setCommodity(e.target.value)}>
            {commodities.length === 0 && <option value="">No commodities</option>}
            {commodities.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>

      <CrudManager<StructureRow>
        key={`structure-${commodity}`}
        title="Farm structure"
        description="Per-commodity, per-geography structure notes and classifications."
        endpoint="/api/markets/manage/structure"
        itemNoun="structure note"
        fields={fields}
        query={commodity ? `commodity=${encodeURIComponent(commodity)}` : undefined}
      />
    </div>
  )
}
