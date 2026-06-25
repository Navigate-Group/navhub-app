'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import pkg from '@/package.json'
import { useTheme } from 'next-themes'
import {
  LayoutDashboard,
  Settings,
  Menu,
  X,
  Sun,
  Moon,
  LogOut,
  ChevronLeft,
  ChevronRight,
  BarChart2,
  ChevronDown,
  Plus,
  FileText,
  KeyRound,
  Megaphone,
  Bot,
  Plug,
  Home,
  MessageSquarePlus,
} from 'lucide-react'
import { signOut } from '@/app/(auth)/actions'
import GroupSwitcher from './GroupSwitcher'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
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
import { getPalette } from '@/lib/themes'
import type { Group, UserGroup, FeatureKey, AppRole } from '@/lib/types'
import { ADMIN_ROLES } from '@/lib/permissions'
import CreateGroupModal from '@/components/groups/CreateGroupModal'
import HelpMenu        from '@/components/layout/HelpMenu'
import FeedbackModal   from '@/components/shared/FeedbackModal'
import AssistantButton from '@/components/assistant/AssistantButton'

// ============================================================
// Nav structure
// ============================================================

// Nav children arrays removed — now inline in collapsible NavGroup components

// ============================================================
// Props
// ============================================================

interface AppShellProps {
  children:         React.ReactNode
  user:             { id: string; email: string }
  groups:           UserGroup[]
  activeGroup:      Group
  visibleFeatures?: FeatureKey[]
  userRole?:        AppRole
  /** Extra top offset in px (used when an overlay banner is present, e.g. impersonation) */
  topOffset?:       number
}

// ============================================================
// Component
// ============================================================

export default function AppShell({ children, user, groups, activeGroup, visibleFeatures, userRole, topOffset = 0 }: AppShellProps) {
  const pathname = usePathname()
  const { theme, setTheme } = useTheme()

  const [collapsed,     setCollapsed]     = useState(false)
  const [mobileOpen,    setMobileOpen]    = useState(false)
  const [mounted,       setMounted]       = useState(false)
  const [showCreateGrp, setShowCreateGrp] = useState(false)
  const [showFeedback,  setShowFeedback]  = useState(false)

  // Derive admin status from active group membership
  const activeRole = userRole ?? (groups.find(g => g.group_id === activeGroup.id)?.role as AppRole | undefined)
  const isAdmin    = activeRole ? ADMIN_ROLES.includes(activeRole) : false
  const isSuperAdmin = activeRole === 'super_admin'

  // Feature visibility — admins see everything; others see only permitted features
  const show = (f: FeatureKey): boolean => isAdmin || (visibleFeatures ?? []).includes(f)

  // Apply full palette CSS vars on mount / group change
  useEffect(() => {
    const palette = getPalette(activeGroup.palette_id)
    document.documentElement.style.setProperty('--palette-primary',   palette.primary)
    document.documentElement.style.setProperty('--palette-secondary', palette.secondary)
    document.documentElement.style.setProperty('--palette-accent',    palette.accent)
    document.documentElement.style.setProperty('--palette-surface',   palette.surface)
    document.documentElement.style.setProperty('--group-primary',     palette.primary)
    // Per-group brand accent (migration 047) — falls back to palette.primary
    const brand = (activeGroup as Group & { brand_color?: string | null }).brand_color
    document.documentElement.style.setProperty('--brand-color', brand || palette.primary)
  }, [activeGroup.palette_id, activeGroup])

  // Brand resolution (with NavHub default)
  const branding = {
    name: ((activeGroup as Group & { brand_name?: string | null }).brand_name) || 'NavHub',
    logo: ((activeGroup as Group & { logo_url?:   string | null }).logo_url)   || null,
  }

  // Browser tab title reflects the brand
  useEffect(() => {
    if (typeof document !== 'undefined') document.title = branding.name
  }, [branding.name])

  useEffect(() => {
    setMounted(true)
    const saved = localStorage.getItem('navhub-sidebar')
    if (saved === 'collapsed') setCollapsed(true)
  }, [])

  function toggleSidebar() {
    const next = !collapsed
    setCollapsed(next)
    localStorage.setItem('navhub-sidebar', next ? 'collapsed' : 'expanded')
  }

  const userInitials = user.email.slice(0, 2).toUpperCase()

  // ────────────────────────────────────────────────────────
  // Sidebar
  // ────────────────────────────────────────────────────────

  function NavLink({
    href, label, Icon, mobile = false,
  }: { href: string; label: string; Icon: React.ComponentType<{ className?: string }>; mobile?: boolean }) {
    const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href))
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            href={href}
            onClick={() => setMobileOpen(false)}
            className={cn(
              'flex items-center gap-3 rounded-md py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-white/10 text-white'
                : 'text-white/60 hover:text-white hover:bg-white/10',
              collapsed && !mobile ? 'justify-center px-2' : 'px-2'
            )}
            style={
              active
                ? { borderLeft: '3px solid var(--palette-primary)', paddingLeft: '5px' }
                : { borderLeft: '3px solid transparent', paddingLeft: '5px' }
            }
          >
            <Icon className="h-5 w-5 shrink-0" />
            {(!collapsed || mobile) && <span>{label}</span>}
          </Link>
        </TooltipTrigger>
        {collapsed && !mobile && (
          <TooltipContent side="right">{label}</TooltipContent>
        )}
      </Tooltip>
    )
  }

  // Old group components removed — replaced by generic NavGroup above

  // Collapsible nav group state (persisted in localStorage)
  const [financialsOpen,  setFinancialsOpen]  = useState(() => pathname.startsWith('/reports') || pathname.startsWith('/cashflow') || pathname.startsWith('/forecasting'))
  const [reportsDocsOpen, setReportsDocsOpen] = useState(() => pathname.startsWith('/reports/custom') || pathname.startsWith('/documents'))

  useEffect(() => {
    try {
      const f = localStorage.getItem('navhub:nav:financials');  if (f !== null) setFinancialsOpen(f === 'true')
      const r = localStorage.getItem('navhub:nav:reportsdocs'); if (r !== null) setReportsDocsOpen(r === 'true')
    } catch { /* ignore */ }
  }, [])

  // Auto-expand group when navigating into it
  useEffect(() => {
    if (pathname.startsWith('/reports/profit') || pathname.startsWith('/reports/balance') || pathname.startsWith('/cashflow') || pathname.startsWith('/forecasting')) setFinancialsOpen(true)
    if (pathname.startsWith('/reports/custom') || pathname.startsWith('/documents')) setReportsDocsOpen(true)
  }, [pathname])

  function toggleNavGroup(key: string, setter: React.Dispatch<React.SetStateAction<boolean>>) {
    setter(prev => {
      const next = !prev
      try { localStorage.setItem(`navhub:nav:${key}`, String(next)) } catch { /* */ }
      return next
    })
  }

  function NavGroup({ label, Icon, open, onToggle, children, visible, mobile: isMob = false }: {
    label: string; Icon: React.ComponentType<{ className?: string }>; open: boolean
    onToggle: () => void; children: React.ReactNode; visible: boolean; mobile?: boolean
  }) {
    if (!visible) return null
    const exp = !collapsed || isMob
    return (
      <div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => { if (collapsed && !isMob) { toggleSidebar(); onToggle() } else onToggle() }}
              className={cn(
                'w-full flex items-center gap-3 rounded-md py-2 text-sm font-medium transition-colors text-white/50 hover:text-white hover:bg-white/10',
                collapsed && !isMob ? 'justify-center px-2' : 'px-2'
              )}
              style={{ borderLeft: '3px solid transparent', paddingLeft: '5px' }}
            >
              <Icon className="h-5 w-5 shrink-0" />
              {exp && (
                <>
                  <span className="flex-1 text-left text-xs uppercase tracking-wider">{label}</span>
                  <ChevronDown className={cn('h-3.5 w-3.5 text-white/30 transition-transform duration-150', open && 'rotate-180')} />
                </>
              )}
            </button>
          </TooltipTrigger>
          {collapsed && !isMob && <TooltipContent side="right">{label}</TooltipContent>}
        </Tooltip>
        {open && exp && (
          <div className="ml-3 border-l border-white/10 pl-1 space-y-0.5">
            {children}
          </div>
        )}
      </div>
    )
  }

  function SubLink({ href, label: lbl, mobile: isMob = false }: { href: string; label: string; mobile?: boolean }) {
    const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href))
    return (
      <Link href={href} onClick={() => setMobileOpen(false)}
        className={cn(
          'flex items-center rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
          active ? 'text-white bg-white/10' : 'text-white/50 hover:text-white hover:bg-white/10'
        )}
        style={active ? { borderLeft: '2px solid var(--palette-accent)' } : { borderLeft: '2px solid transparent' }}>
        {lbl}
      </Link>
    )
    void isMob // satisfy lint
  }

  function Sidebar({ mobile = false }: { mobile?: boolean }) {
    return (
      <TooltipProvider delayDuration={0}>
        <aside
          className={cn(
            'flex flex-col border-r border-white/10 transition-all duration-200',
            mobile
              ? 'fixed inset-y-0 left-0 z-50 w-64 shadow-xl'
              : cn('hidden lg:flex sticky h-[calc(100vh-3.5rem)]', collapsed ? 'w-16' : 'w-56')
          )}
          style={{ backgroundColor: 'var(--palette-surface)', ...(!mobile ? { top: 56 + topOffset } : {}) }}
        >
          <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-1">
            {/* Dashboard — always visible */}
            <NavLink href="/dashboard" label="Dashboard" Icon={LayoutDashboard} mobile={mobile} />

            {/* Financials group */}
            <NavGroup label="Financials" Icon={BarChart2} open={financialsOpen}
              onToggle={() => toggleNavGroup('financials', setFinancialsOpen)}
              visible={show('financials') || show('reports')} mobile={mobile}>
              {show('reports') && <SubLink href="/reports/profit-loss" label="P&L" mobile={mobile} />}
              {show('reports') && <SubLink href="/reports/balance-sheet" label="Balance Sheet" mobile={mobile} />}
              {show('financials') && <SubLink href="/cashflow" label="Cash Flow" mobile={mobile} />}
              {show('financials') && <SubLink href="/forecasting/revenue" label="Forecasting" mobile={mobile} />}
            </NavGroup>

            {/* Marketing — single item */}
            {show('marketing') && <NavLink href="/marketing" label="Marketing" Icon={Megaphone} mobile={mobile} />}

            {/* Reports & Documents group */}
            <NavGroup label="Reports & Docs" Icon={FileText} open={reportsDocsOpen}
              onToggle={() => toggleNavGroup('reportsdocs', setReportsDocsOpen)}
              visible={show('reports') || show('documents')} mobile={mobile}>
              {show('reports') && <SubLink href="/reports/custom" label="Reports" mobile={mobile} />}
              {show('documents') && <SubLink href="/documents" label="Documents" mobile={mobile} />}
            </NavGroup>

            {/* Agents — top level */}
            {show('agents') && <NavLink href="/agents" label="Agents" Icon={Bot} mobile={mobile} />}

            {/* Integrations — admin-only, between Agents and Settings */}
            {isAdmin && (
              <NavLink href="/integrations" label="Integrations" Icon={Plug} mobile={mobile} />
            )}

            {/* Settings — top level */}
            {show('settings') && <NavLink href="/settings" label="Settings" Icon={Settings} mobile={mobile} />}

            {(!collapsed || mobile) && <HelpMenu userEmail={user.email} />}
          </nav>

          {/* Assistant button — pinned to sidebar bottom */}
          <div className="px-3 pb-2">
            {collapsed && !mobile ? (
              <AssistantButton
                sidebarMode
                collapsed
                groupId={activeGroup.id}
              />
            ) : (
              <AssistantButton
                sidebarMode
                groupId={activeGroup.id}
                onOpen={() => { if (mobile) setMobileOpen(false) }}
              />
            )}
          </div>

          {!mobile && mounted && (
            <div className="border-t border-white/10 p-2">
              <button
                onClick={toggleSidebar}
                className="flex w-full items-center justify-center gap-2 rounded-md px-2 py-1.5 text-xs text-white/50 hover:bg-white/10 hover:text-white/80 transition-colors"
              >
                {collapsed
                  ? <ChevronRight className="h-4 w-4" />
                  : <><ChevronLeft className="h-4 w-4" /><span>Collapse</span></>}
              </button>
            </div>
          )}
        </aside>
      </TooltipProvider>
    )
  }

  // ────────────────────────────────────────────────────────
  // Top bar + layout
  // ────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col min-h-screen">
      {/* ── Top bar ── */}
      <header
        className="fixed inset-x-0 z-40 h-14 bg-background/95 backdrop-blur flex items-center gap-3 px-4"
        style={{ top: topOffset, borderBottom: '2px solid var(--palette-primary)' }}
      >
        <button
          className="lg:hidden text-muted-foreground hover:text-foreground"
          onClick={() => setMobileOpen(o => !o)}
          aria-label="Toggle navigation"
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>

        <button
          className="hidden lg:block text-muted-foreground hover:text-foreground"
          onClick={toggleSidebar}
          aria-label="Toggle sidebar"
        >
          <Menu className="h-5 w-5" />
        </button>

        <Link href="/dashboard" className="font-bold text-lg tracking-tight mr-2 flex items-center gap-2">
          {branding.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={branding.logo}
              alt={branding.name}
              className="h-7 w-auto max-w-[160px] object-contain"
            />
          ) : branding.name === 'NavHub' ? (
            <>Nav<span style={{ color: 'var(--brand-color, var(--palette-primary))' }}>Hub</span></>
          ) : (
            <span style={{ color: 'var(--brand-color, var(--palette-primary))' }}>{branding.name}</span>
          )}
        </Link>

        <div className="flex-1" />

        <div className="flex items-center gap-2">
          {groups.length > 0 && (
            <GroupSwitcher groups={groups} activeGroup={activeGroup} />
          )}

          {mounted && (
            <button
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className="rounded-md p-2 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          )}

          {/* User menu */}
          <DropdownMenu>
            <DropdownMenuTrigger className="focus:outline-none">
              <Avatar className="h-8 w-8 cursor-pointer">
                <AvatarFallback
                  className="text-xs font-semibold"
                  style={{ backgroundColor: 'var(--palette-primary)', color: '#ffffff' }}
                >
                  {userInitials}
                </AvatarFallback>
              </Avatar>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="font-normal">
                <p className="text-xs text-muted-foreground truncate">{user.email}</p>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />

              {/* Home — landing page (group picker for users with multiple groups) */}
              <DropdownMenuItem asChild className="cursor-pointer text-foreground">
                <Link href="/landing">
                  <Home className="mr-2 h-4 w-4" />
                  Home
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />

              {/* Create Group — super_admin and group_admin */}
              {(isSuperAdmin || isAdmin) && (
                <>
                  <DropdownMenuItem
                    onSelect={() => setShowCreateGrp(true)}
                    className="cursor-pointer text-foreground"
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Create new group
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}

              {/* Share feedback — opens the structured 3-question modal */}
              <DropdownMenuItem
                onSelect={() => setShowFeedback(true)}
                className="cursor-pointer text-foreground"
              >
                <MessageSquarePlus className="mr-2 h-4 w-4" />
                Share feedback
              </DropdownMenuItem>
              <DropdownMenuSeparator />

              <DropdownMenuItem asChild className="cursor-pointer text-foreground">
                <Link href={`/forgot-password?email=${encodeURIComponent(user.email)}`}>
                  <KeyRound className="mr-2 h-4 w-4" />
                  Change password
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
              <div className="px-3 py-2 border-t border-border">
                <p className="text-[11px] text-muted-foreground text-center">
                  {branding.name} v{pkg.version}.{process.env.NEXT_PUBLIC_BUILD_DATE ?? '0'}{process.env.NEXT_PUBLIC_BUILD_HASH ? ` · ${process.env.NEXT_PUBLIC_BUILD_HASH}` : ''}
                </p>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Create Group Modal */}
      {showCreateGrp && (
        <CreateGroupModal onClose={() => setShowCreateGrp(false)} />
      )}

      {/* Feedback modal — three-question structured form */}
      <FeedbackModal open={showFeedback} onClose={() => setShowFeedback(false)} />

      {/* ── Body ── */}
      <div className="flex flex-1" style={{ paddingTop: 56 + topOffset }}>
        <Sidebar />

        {mobileOpen && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/50 lg:hidden"
              onClick={() => setMobileOpen(false)}
            />
            <Sidebar mobile />
          </>
        )}

        <main className="flex-1 overflow-auto p-6">
          {children}
        </main>
      </div>
    </div>
  )
}
