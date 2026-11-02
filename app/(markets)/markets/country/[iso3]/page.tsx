import MarketsTabs from '@/components/markets/MarketsTabs'
import CountryProfile from '@/components/markets/country/CountryProfile'

/**
 * Markets Country profile for a specific country (MKT-4). The Overview map and
 * ranking lists (MKT-3) link here via /markets/country/[iso3]. The client
 * component seeds its initial selection from the route param, then lets the
 * viewer switch commodity / country / season / valuation in place. Read-only.
 */
export default function MarketsCountryByIsoPage({ params }: { params: { iso3: string } }) {
  return (
    <div className="space-y-4">
      <MarketsTabs />
      <CountryProfile initialIso3={params.iso3} />
    </div>
  )
}
