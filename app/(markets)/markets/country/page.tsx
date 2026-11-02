import MarketsTabs from '@/components/markets/MarketsTabs'
import CountryProfile from '@/components/markets/country/CountryProfile'

/**
 * Markets Country profile tab (MKT-4). Drills into a single commodity/country:
 * all seven measures with ranks and season flags, production-by-season, regions,
 * farm structure and operators. Read-only; access gated upstream by the
 * (markets) layout + middleware.
 */
export default function MarketsCountryPage() {
  return (
    <div className="space-y-4">
      <MarketsTabs />
      <CountryProfile />
    </div>
  )
}
