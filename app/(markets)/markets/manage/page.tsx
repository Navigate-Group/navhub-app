import Link from 'next/link'
import { Settings2, Globe2, Sprout, Database, BookMarked, Boxes } from 'lucide-react'
import { requireManagerPage } from './_guard'
import ManageTabs from '@/components/markets/manage/ManageTabs'

/**
 * Markets curation home (MKT-6). Tab-based navigation into the five manage
 * surfaces plus the commodity CRUD. Managers only — middleware enforces a hard
 * 403 for non-managers; this server check is defence-in-depth.
 */
const SECTIONS: Array<{ href: string; label: string; blurb: string; Icon: React.ComponentType<{ className?: string }> }> = [
  { href: '/markets/manage/commodities', label: 'Commodities', blurb: 'Add, edit and archive the tradable goods Markets tracks.', Icon: Boxes },
  { href: '/markets/manage/country', label: 'Country', blurb: 'Countries and sub-national regions (geo units).', Icon: Globe2 },
  { href: '/markets/manage/structure', label: 'Farm structure', blurb: 'Per-commodity, per-geography structure notes.', Icon: Sprout },
  { href: '/markets/manage/coverage', label: 'Data coverage', blurb: 'Price series, FX rates and valuation methods.', Icon: Database },
  { href: '/markets/manage/sources', label: 'Sources', blurb: 'The source registry behind every figure.', Icon: BookMarked },
]

export default async function MarketsManagePage() {
  await requireManagerPage()

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <ManageTabs />

      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-muted">
          <Settings2 className="h-6 w-6 text-foreground" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Manage Markets</h1>
          <p className="text-sm text-muted-foreground">
            Curate the reference data behind the explorer and agent analyses. Every change is recorded in the audit log.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SECTIONS.map(({ href, label, blurb, Icon }) => (
          <Link
            key={href}
            href={href}
            className="group rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-accent/40"
          >
            <div className="mb-2 flex items-center gap-2">
              <Icon className="h-4 w-4 text-muted-foreground group-hover:text-foreground" />
              <span className="font-medium">{label}</span>
            </div>
            <p className="text-sm text-muted-foreground">{blurb}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}
