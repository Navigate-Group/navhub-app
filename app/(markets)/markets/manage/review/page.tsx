import { requireManagerPage } from '../_guard'
import ManagePage from '@/components/markets/manage/ManagePage'
import ReviewQueueManager from '@/components/markets/manage/ReviewQueueManager'
import { listCommodities, listGeoUnits, listSources } from '@/lib/markets/manage'

export const runtime = 'nodejs'

/**
 * Markets Review Queue (MKT-7b). Managers only — middleware hard-403s
 * non-managers on /markets/manage/*; requireManagerPage() is defence-in-depth.
 *
 * The central hub where PENDING observations from document extraction (MKT-7a)
 * and template import are validated, corrected, and promoted into the live
 * dataset. Reference lists (commodities, geo units, sources) are loaded here for
 * the edit modal's mapping pickers and unmatched-resolution flows.
 */
export default async function ManageReviewPage() {
  await requireManagerPage()

  const [commodities, geographies, sources] = await Promise.all([
    listCommodities(),
    listGeoUnits(),
    listSources(),
  ])

  return (
    <ManagePage
      title="Review queue"
      description="Review, correct and approve extracted observations. Approved figures go live and supersede the previous figure; every decision is recorded in the audit log."
    >
      <ReviewQueueManager
        commodities={commodities.map(c => ({ id: c.id, name: c.name }))}
        geographies={geographies.map(g => ({ id: g.id, name: g.name }))}
        sources={sources.map(s => ({ id: s.id, name: s.name }))}
      />
    </ManagePage>
  )
}
