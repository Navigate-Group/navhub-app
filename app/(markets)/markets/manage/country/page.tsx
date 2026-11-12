import { requireManagerPage } from '../_guard'
import ManagePage from '@/components/markets/manage/ManagePage'
import CountryManager from '@/components/markets/manage/CountryManager'

/** Markets geo-unit (country / region) curation (MKT-6). Managers only. */
export default async function ManageCountryPage() {
  await requireManagerPage()
  return (
    <ManagePage title="Country" description="Curate countries and sub-national regions. Archived rows stay in the database but are excluded from explorer dropdowns.">
      <CountryManager />
    </ManagePage>
  )
}
