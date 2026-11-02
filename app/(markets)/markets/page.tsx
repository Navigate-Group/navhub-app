import { LineChart } from 'lucide-react'

/**
 * Markets explorer (MKT-1 shell). The data model, categories and commodities
 * arrive in MKT-2 — this is the gated landing surface for markets_viewer /
 * markets_manager / super admin.
 */
export default function MarketsHomePage() {
  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-muted">
          <LineChart className="h-6 w-6 text-foreground" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Markets</h1>
          <p className="text-sm text-muted-foreground">Commodity intelligence explorer.</p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-6">
        <p className="text-sm text-muted-foreground">
          You have access to Markets. Categories and commodities will appear here
          once the data model is in place.
        </p>
      </div>
    </div>
  )
}
