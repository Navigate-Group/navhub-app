'use client'

import CrudManager, { type CrudRow, type FieldDef } from './CrudManager'

interface CommodityRow extends CrudRow {
  name: string
  scope_note: string | null
  season_basis: string | null
  seasons: string[]
  default_season: string | null
  default_country: string | null
  sort_order: number
}

const fields: FieldDef<CommodityRow>[] = [
  { name: 'id', label: 'ID', required: true, createOnly: true, placeholder: 'banana' },
  { name: 'name', label: 'Name', required: true, placeholder: 'Bananas' },
  { name: 'seasons', label: 'Seasons', placeholder: '2022, 2023, 2024', cell: r => (r.seasons?.length ? r.seasons.join(', ') : '—') },
  { name: 'default_season', label: 'Default season', placeholder: '2024' },
  { name: 'default_country', label: 'Default country', placeholder: 'IND' },
  { name: 'season_basis', label: 'Season basis', placeholder: 'calendar', hideInTable: true },
  { name: 'scope_note', label: 'Scope note', type: 'textarea', hideInTable: true },
  { name: 'sort_order', label: 'Sort order', type: 'number', placeholder: '0' },
]

export default function CommoditiesManager() {
  return (
    <CrudManager<CommodityRow>
      title="Commodities"
      description="The tradable goods Markets tracks. Seasons are a comma-separated list; valuation methods are curated on the Data coverage tab."
      endpoint="/api/markets/manage/commodities"
      itemNoun="commodity"
      fields={fields}
    />
  )
}
