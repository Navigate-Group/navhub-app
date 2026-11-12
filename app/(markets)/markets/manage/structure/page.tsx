import { requireManagerPage } from '../_guard'
import ManagePage from '@/components/markets/manage/ManagePage'
import StructureManager from '@/components/markets/manage/StructureManager'

/** Markets farm-structure curation (MKT-6). Managers only. */
export default async function ManageStructurePage() {
  await requireManagerPage()
  return (
    <ManagePage title="Farm structure" description="Per-commodity, per-geography structure notes and classifications.">
      <StructureManager />
    </ManagePage>
  )
}
