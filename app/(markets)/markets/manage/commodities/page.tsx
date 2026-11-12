import { requireManagerPage } from '../_guard'
import ManagePage from '@/components/markets/manage/ManagePage'
import CommoditiesManager from '@/components/markets/manage/CommoditiesManager'

/** Markets commodity CRUD (MKT-6). Managers only. */
export default async function ManageCommoditiesPage() {
  await requireManagerPage()
  return (
    <ManagePage title="Commodities" description="Add, edit and archive the commodities that underpin every explorer view and agent analysis.">
      <CommoditiesManager />
    </ManagePage>
  )
}
