import MarketsTabs from '@/components/markets/MarketsTabs'
import CoverageView from '@/components/markets/coverage/CoverageView'

/**
 * Markets Data coverage tab (MKT-4). A table of the largest producers by
 * production with configurable columns and Have / Partial / Gap status chips,
 * so viewers can see where the data is complete and where it is missing.
 * Read-only; access gated upstream by the (markets) layout + middleware.
 */
export default function MarketsCoveragePage() {
  return (
    <div className="space-y-4">
      <MarketsTabs />
      <CoverageView />
    </div>
  )
}
