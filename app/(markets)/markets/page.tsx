import OverviewExplorer from '@/components/markets/overview/OverviewExplorer'
import MarketsTabs from '@/components/markets/MarketsTabs'

/**
 * Markets explorer — Overview tab (MKT-3). The viewer-facing surface for
 * exploring production, value, export and export-share data by commodity,
 * season, scope and valuation method. Access is gated by the (markets) layout
 * and middleware; Viewers and Managers see identical read-only content. The
 * tab row (MKT-4) links through to the Country / Farm structure / Data coverage
 * / Sources views.
 */
export default function MarketsHomePage() {
  return (
    <div className="space-y-4">
      <MarketsTabs />
      <OverviewExplorer />
    </div>
  )
}
