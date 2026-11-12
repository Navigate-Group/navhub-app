import { requireManagerPage } from '../_guard'
import ManagePage from '@/components/markets/manage/ManagePage'
import SourcesManager from '@/components/markets/manage/SourcesManager'

/** Markets source-registry curation (MKT-6). Managers only. */
export default async function ManageSourcesPage() {
  await requireManagerPage()
  return (
    <ManagePage title="Sources" description="The registry of every source behind Markets figures. Archived sources are hidden from dropdowns but kept for provenance.">
      <SourcesManager />
    </ManagePage>
  )
}
