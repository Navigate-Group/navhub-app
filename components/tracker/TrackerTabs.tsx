'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

type Tab = { href: string; label: string; soon?: boolean }

/**
 * Shared tracker section tabs (design spec): My week · Projects · People ·
 * Weekly review · Settings. Projects and Settings are built; People and Weekly
 * review carry a small "Soon" badge and lead to a coming-soon placeholder.
 * Settings is shown only to Managers / Group Owners (the server passes
 * `showSettings`).
 * Horizontally scrollable on a phone. Colours follow the group theme via
 * `--primary` / `text-foreground`.
 *
 * The group name and page title are rendered above the tabs by TrackerHeader,
 * in the agreed order (group name → page title + buttons → tabs).
 */
export default function TrackerTabs({
  showSettings,
}: {
  showSettings: boolean
}) {
  const pathname = usePathname()

  const tabs: Tab[] = [
    { href: '/tracker/my-week', label: 'My week' },
    { href: '/tracker/plans', label: 'Projects' },
    { href: '/tracker/people', label: 'People' },
    { href: '/tracker/weekly-review', label: 'Weekly review' },
    ...(showSettings ? [{ href: '/tracker/settings', label: 'Settings' }] : []),
  ]

  return (
    <div>
      <nav aria-label="Projects sections" className="-mx-6 border-b px-6">
        <ul className="flex gap-1 overflow-x-auto">
          {tabs.map((t) => {
            const active = pathname === t.href || pathname.startsWith(t.href + '/')
            return (
              <li key={t.href} className="shrink-0">
                <Link
                  href={t.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                    active
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t.label}
                  {t.soon && (
                    <span className="rounded-full border border-transparent bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Soon
                    </span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
    </div>
  )
}
