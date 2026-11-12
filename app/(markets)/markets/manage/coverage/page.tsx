import { requireManagerPage } from '../_guard'
import ManagePage from '@/components/markets/manage/ManagePage'
import CoverageManager from '@/components/markets/manage/CoverageManager'

/** Markets data-coverage curation: prices, FX rates, valuation methods (MKT-6). */
export default async function ManageCoveragePage() {
  await requireManagerPage()
  return (
    <ManagePage title="Data coverage" description="Curate price series, FX rates and the per-commodity valuation methods. Seasons and valuation methods are context-filtered by commodity.">
      <CoverageManager />
    </ManagePage>
  )
}
