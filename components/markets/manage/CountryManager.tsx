'use client'

import CrudManager, { type CrudRow, type FieldDef } from './CrudManager'

interface GeoRow extends CrudRow {
  name: string
  level: string
  m49: string | null
  continent: string | null
  parent: string | null
  region_type: string | null
}

const fields: FieldDef<GeoRow>[] = [
  { name: 'id', label: 'ID', required: true, createOnly: true, placeholder: 'IND or IND-00' },
  { name: 'name', label: 'Name', required: true, placeholder: 'India' },
  {
    name: 'level',
    label: 'Level',
    type: 'select',
    required: true,
    options: [
      { value: 'country', label: 'Country' },
      { value: 'region', label: 'Region' },
    ],
  },
  { name: 'm49', label: 'M49', placeholder: 'UN M49 code' },
  { name: 'continent', label: 'Continent', placeholder: 'Asia' },
  { name: 'parent', label: 'Parent', placeholder: 'Parent country id (regions)' },
  { name: 'region_type', label: 'Region type', placeholder: 'State / Province', hideInTable: true },
]

export default function CountryManager() {
  return (
    <CrudManager<GeoRow>
      title="Geographies"
      description="Countries and sub-national regions. Archived rows are excluded from explorer dropdowns."
      endpoint="/api/markets/manage/geo-units"
      itemNoun="geography"
      fields={fields}
    />
  )
}
