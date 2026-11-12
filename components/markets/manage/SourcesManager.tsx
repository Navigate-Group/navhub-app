'use client'

import CrudManager, { type CrudRow, type FieldDef } from './CrudManager'

interface SourceRow extends CrudRow {
  name: string
  short: string | null
  method: string | null
  licence: string | null
  vintage: string | null
  url: string | null
}

const fields: FieldDef<SourceRow>[] = [
  { name: 'id', label: 'ID', required: true, createOnly: true, placeholder: 'faostat_2024' },
  { name: 'name', label: 'Name', required: true, placeholder: 'FAOSTAT' },
  { name: 'short', label: 'Short', placeholder: 'FAO' },
  { name: 'method', label: 'Method', placeholder: 'Survey / estimate' },
  { name: 'licence', label: 'Licence', placeholder: 'CC BY 4.0' },
  { name: 'vintage', label: 'Vintage', placeholder: '2024' },
  { name: 'url', label: 'URL', placeholder: 'https://…', hideInTable: true },
]

export default function SourcesManager() {
  return (
    <CrudManager<SourceRow>
      title="Source registry"
      description="Every figure in Markets is traceable to a registered source. Archived sources are hidden from dropdowns."
      endpoint="/api/markets/manage/sources"
      itemNoun="source"
      fields={fields}
    />
  )
}
