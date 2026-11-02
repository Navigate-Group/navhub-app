'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTheme } from 'next-themes'
import { Home, Sun, Moon, Monitor, LogOut, LineChart } from 'lucide-react'
import { signOut } from '@/app/(auth)/actions'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

type ThemeChoice = 'light' | 'dark' | 'system'

const THEME_OPTIONS: Array<{ value: ThemeChoice; label: string; Icon: React.ComponentType<{ className?: string }> }> = [
  { value: 'light',  label: 'Light', Icon: Sun },
  { value: 'dark',   label: 'Dark',  Icon: Moon },
  { value: 'system', label: 'Auto',  Icon: Monitor },
]

/**
 * Markets shell (MKT-1): top bar + breadcrumbs. Intentionally free of Group /
 * Company context. The theme toggle writes to next-themes (persisted to
 * localStorage) — UI only, no data model yet.
 */
export default function MarketsShell({
  children,
  userEmail,
  canManage,
}: {
  children: React.ReactNode
  userEmail: string
  canManage: boolean
}) {
  const pathname = usePathname()
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const userInitials = (userEmail || '??').slice(0, 2).toUpperCase()
  const onManage = pathname.startsWith('/markets/manage')

  // Breadcrumbs: Markets › Category › Commodity only (no Group/Company). For
  // this phase there are no category/commodity routes yet, so the trail is just
  // "Markets" (plus "Manage" when on the curation sub-tree).
  const crumbs: Array<{ label: string; href?: string }> = [{ label: 'Markets', href: '/markets' }]
  if (onManage) crumbs.push({ label: 'Manage' })

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Top bar */}
      <header
        className="fixed inset-x-0 top-0 z-40 h-14 bg-background/95 backdrop-blur flex items-center gap-3 px-4"
        style={{ borderBottom: '2px solid var(--palette-primary, hsl(var(--primary)))' }}
      >
        <Link href="/markets" className="font-bold text-lg tracking-tight mr-2 flex items-center gap-2">
          <LineChart className="h-5 w-5" />
          <span>Markets</span>
        </Link>

        {/* Back to NavHub */}
        <Link
          href="/dashboard"
          className="hidden sm:inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <Home className="h-4 w-4" />
          NavHub
        </Link>

        {/* Manage — Managers only */}
        {canManage && (
          <Link
            href="/markets/manage"
            className={cn(
              'ml-2 text-sm transition-colors',
              onManage ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Manage
          </Link>
        )}

        <div className="flex-1" />

        {/* Theme control — Light / Dark / Auto */}
        {mounted && (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="rounded-md p-2 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors focus:outline-none"
              aria-label="Theme"
            >
              {theme === 'dark'
                ? <Moon className="h-4 w-4" />
                : theme === 'light'
                  ? <Sun className="h-4 w-4" />
                  : <Monitor className="h-4 w-4" />}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuLabel className="text-xs">Theme</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {THEME_OPTIONS.map(({ value, label, Icon }) => (
                <DropdownMenuItem
                  key={value}
                  onSelect={() => setTheme(value)}
                  className={cn('cursor-pointer', theme === value && 'font-medium text-foreground')}
                >
                  <Icon className="mr-2 h-4 w-4" />
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* User menu */}
        <DropdownMenu>
          <DropdownMenuTrigger className="focus:outline-none">
            <Avatar className="h-8 w-8 cursor-pointer">
              <AvatarFallback className="text-xs font-semibold">{userInitials}</AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="font-normal">
              <p className="text-xs text-muted-foreground truncate">{userEmail}</p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="cursor-pointer">
              <Link href="/dashboard">
                <Home className="mr-2 h-4 w-4" />
                Back to NavHub
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={async () => { await signOut() }}
              className="text-destructive focus:text-destructive cursor-pointer"
            >
              <LogOut className="mr-2 h-4 w-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* Body */}
      <div className="pt-14">
        {/* Breadcrumbs */}
        <nav className="border-b border-border px-6 py-2.5 text-sm text-muted-foreground" aria-label="Breadcrumb">
          <ol className="flex items-center gap-1.5">
            {crumbs.map((c, i) => (
              <li key={c.label} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-muted-foreground/50">›</span>}
                {c.href && i < crumbs.length - 1 ? (
                  <Link href={c.href} className="hover:text-foreground transition-colors">{c.label}</Link>
                ) : (
                  <span className={i === crumbs.length - 1 ? 'text-foreground' : ''}>{c.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>

        <main className="p-6">{children}</main>
      </div>
    </div>
  )
}
