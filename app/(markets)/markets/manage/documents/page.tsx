import { requireManagerPage } from '../_guard'
import ManagePage from '@/components/markets/manage/ManagePage'
import DocumentsManager from '@/components/markets/manage/DocumentsManager'
import { listCommodities, listGeoUnits, listSources } from '@/lib/markets/manage'

export const runtime = 'nodejs'

/**
 * Markets document upload & extraction (MKT-7a). Managers only — middleware
 * hard-403s non-managers on /markets/manage/*; requireManagerPage() is
 * defence-in-depth. Managers upload PDF/XLSX/CSV/PNG/JPEG files with metadata
 * hints; a Document Extractor turns them into pending observations / structure
 * for review in a later phase (MKT-7b).
 */
export default async function ManageDocumentsPage() {
  await requireManagerPage()

  const [commodities, geographies, sources] = await Promise.all([
    listCommodities(),
    listGeoUnits(),
    listSources(),
  ])

  return (
    <ManagePage
      title="Documents"
      description="Upload source documents and let the Document Extractor turn them into proposed observations. Extracted data is queued for review before it is published."
    >
      <DocumentsManager
        commodities={commodities.map(c => ({ id: c.id, name: c.name }))}
        geographies={geographies.map(g => ({ id: g.id, name: g.name }))}
        sources={sources.map(s => ({ id: s.id, name: s.name }))}
      />
    </ManagePage>
  )
}
