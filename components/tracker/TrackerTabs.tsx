'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

type Tab = { href: string; label: string }

/**
 * Shared tracker header tabs (P5): My week · Projects · People · Weekly review
 * · Settings. Settings is shown only to Managers / Group Owners (the server
 * passes `showSettings`). Horizontally scrollable on a phone.
 */
export default function TrackerTabs({ showSettings }: { showSettings: boolean }) {
  const pathname = usePathname()

  const tabs: Tab[] = [
    { href: '/tracker/my-week', label: 'My week' },
    { href: '/tracker/plans', label: 'Projects' },
    { href: '/tracker/people', label: 'People' },
    { href: '/tracker/weekly-review', label: 'Weekly review' },
    ...(showSettings ? [{ href: '/tracker/settings', label: 'Settings' }] : []),
  ]

  return (
    <nav
      aria-label="Projects sections"
      className="-mx-6 mb-4 border-b px-6"
    >
      <ul className="flex gap-1 overflow-x-auto">
        {tabs.map((t) => {
          const active = pathname === t.href || pathname.startsWith(t.href + '/')
          return (
            <li key={t.href} className="shrink-0">
              <Link
                href={t.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-block whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
