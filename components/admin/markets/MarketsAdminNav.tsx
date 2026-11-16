'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * Sub-navigation for the Admin → Markets control surfaces (MKT-8). Links the
 * Access, Settings, Usage and Audit pages. Super-admin only (the whole /admin
 * tree is gated by middleware + the admin layout). Styled to match the dark
 * admin shell.
 */
const TABS = [
  { label: 'Access',   href: '/admin/markets' },
  { label: 'Settings', href: '/admin/markets/settings' },
  { label: 'Usage',    href: '/admin/markets/usage' },
  { label: 'Audit',    href: '/admin/markets/audit' },
]

export default function MarketsAdminNav() {
  const pathname = usePathname()
  return (
    <div className="flex items-center gap-1 border-b border-zinc-800 pb-3">
      {TABS.map(({ label, href }) => {
        const active = pathname === href
        return (
          <Link
            key={href}
            href={href}
            className={
              'px-3 py-1.5 rounded text-sm transition-colors ' +
              (active
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                : 'text-zinc-400 hover:text-white hover:bg-zinc-800 border border-transparent')
            }
          >
            {label}
          </Link>
        )
      })}
    </div>
  )
}
