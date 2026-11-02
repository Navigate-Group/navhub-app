import OverviewExplorer from '@/components/markets/overview/OverviewExplorer'

/**
 * Markets explorer — Overview tab (MKT-3). The viewer-facing surface for
 * exploring production, value, export and export-share data by commodity,
 * season, scope and valuation method. Access is gated by the (markets) layout
 * and middleware; Viewers and Managers see identical read-only content.
 */
export default function MarketsHomePage() {
  return <OverviewExplorer />
}
