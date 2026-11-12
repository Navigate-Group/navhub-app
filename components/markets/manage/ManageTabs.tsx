'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

/**
 * Markets curation tab navigation (MKT-6). Mirrors the read-only Overview tabs
 * but for the manage surface: Overview (manage home), Country (geo units), Farm
 * structure, Data coverage (prices + FX + valuation methods), Sources, plus the
 * Commodities CRUD section. Manager+ only — gated upstream by middleware and the
 * (markets) layout.
 */
const TABS: Array<{ href: string; label: string; match: (p: string) => boolean }> = [
  { href: '/markets/manage', label: 'Overview', match: p => p === '/markets/manage' },
  { href: '/markets/manage/commodities', label: 'Commodities', match: p => p.startsWith('/markets/manage/commodities') },
  { href: '/markets/manage/country', label: 'Country', match: p => p.startsWith('/markets/manage/country') },
  { href: '/markets/manage/structure', label: 'Farm structure', match: p => p.startsWith('/markets/manage/structure') },
  { href: '/markets/manage/coverage', label: 'Data coverage', match: p => p.startsWith('/markets/manage/coverage') },
  { href: '/markets/manage/sources', label: 'Sources', match: p => p.startsWith('/markets/manage/sources') },
]

export default function ManageTabs() {
  const pathname = usePathname()
  return (
    <nav className="mx-auto flex max-w-6xl flex-wrap gap-1 border-b border-border" aria-label="Markets curation views">
      {TABS.map(tab => {
        const active = tab.match(pathname)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
            )}
            aria-current={active ? 'page' : undefined}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
