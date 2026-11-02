'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

/**
 * Markets primary tab navigation (MKT-4). Sits under the breadcrumb and lets
 * viewers move between the Overview (MKT-3) and the secondary analysis views:
 * Country profile, Farm structure, Data coverage and Sources. Read-only and
 * identical for Viewers and Managers — role gating is enforced upstream in the
 * (markets) layout + middleware.
 */
const TABS: Array<{ href: string; label: string; match: (p: string) => boolean }> = [
  { href: '/markets', label: 'Overview', match: p => p === '/markets' },
  { href: '/markets/country', label: 'Country', match: p => p.startsWith('/markets/country') },
  { href: '/markets/structure', label: 'Farm structure', match: p => p.startsWith('/markets/structure') },
  { href: '/markets/coverage', label: 'Data coverage', match: p => p.startsWith('/markets/coverage') },
  { href: '/markets/sources', label: 'Sources', match: p => p.startsWith('/markets/sources') },
]

export default function MarketsTabs() {
  const pathname = usePathname()
  return (
    <nav className="mx-auto flex max-w-6xl flex-wrap gap-1 border-b border-border" aria-label="Markets views">
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
