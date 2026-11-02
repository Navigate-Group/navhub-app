import MarketsTabs from '@/components/markets/MarketsTabs'
import StructureView from '@/components/markets/structure/StructureView'

/**
 * Markets Farm structure tab (MKT-4). Cards per country showing area size,
 * turnover, ownership, notes and sources for the selected commodity and scope.
 * Read-only; access gated upstream by the (markets) layout + middleware.
 */
export default function MarketsStructurePage() {
  return (
    <div className="space-y-4">
      <MarketsTabs />
      <StructureView />
    </div>
  )
}
