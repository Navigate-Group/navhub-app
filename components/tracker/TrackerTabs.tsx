'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

type Tab = { href: string; label: string; soon?: boolean }

/**
 * Shared tracker top navigation (design spec): the group's name in small grey
 * text, then the section tabs — My week · Projects · People · Weekly review ·
 * Settings. Only Projects is built; the other tabs carry a small "Soon" badge
 * and lead to a coming-soon placeholder. Settings is shown only to Managers /
 * Group Owners (the server passes `showSettings`). Horizontally scrollable on a
 * phone. Colours follow the group theme via `--primary` / `text-foreground`.
 */
export default function TrackerTabs({
  showSettings,
  groupName,
}: {
  showSettings: boolean
  groupName?: string | null
}) {
  const pathname = usePathname()

  const tabs: Tab[] = [
    { href: '/tracker/my-week', label: 'My week', soon: true },
    { href: '/tracker/plans', label: 'Projects' },
    { href: '/tracker/people', label: 'People', soon: true },
    { href: '/tracker/weekly-review', label: 'Weekly review', soon: true },
    ...(showSettings ? [{ href: '/tracker/settings', label: 'Settings', soon: true }] : []),
  ]

  return (
    <div className="mb-4">
      {groupName && (
        <p className="px-0 text-xs text-muted-foreground">{groupName}</p>
      )}
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
