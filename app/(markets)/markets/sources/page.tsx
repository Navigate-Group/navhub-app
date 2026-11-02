import MarketsTabs from '@/components/markets/MarketsTabs'
import SourcesView from '@/components/markets/sources/SourcesView'

/**
 * Markets Sources tab (MKT-4). The source registry with method, licence and
 * vintage metadata, plus the price series and FX rates keyed to their source
 * and licence badges. Read-only; access gated upstream by the (markets) layout
 * + middleware.
 */
export default function MarketsSourcesPage() {
  return (
    <div className="space-y-4">
      <MarketsTabs />
      <SourcesView />
    </div>
  )
}
