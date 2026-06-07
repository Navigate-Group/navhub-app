import Link     from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import AssistantButton from '@/components/assistant/AssistantButton'
import AdminFeedbackNavLink from '@/components/admin/AdminFeedbackNavLink'

const NAV_LINKS = [
  { label: 'Dashboard',  href: '/admin' },
  { label: 'Groups',     href: '/admin/groups' },
  { label: 'Users',      href: '/admin/users' },
  { label: 'Agents',     href: '/admin/agents' },
  { label: 'Agent Runs', href: '/admin/agent-runs' },
  // ── Intelligence cluster ────────────────────────────────────────────
  // Templates, Skills, Knowledge and Builder are the operator's toolbox
  // for shaping how all agents behave across the platform.
  { label: 'Templates',  href: '/admin/templates' },
  { label: 'Skills',     href: '/admin/skills' },
  { label: 'Knowledge',  href: '/admin/knowledge' },
  { label: 'Builder',    href: '/admin/builder' },
  { label: 'Sage',       href: '/admin/sage' },
  // Feedback rendered separately via AdminFeedbackNavLink for the badge
  { label: 'Audit',      href: '/admin/audit' },
  { label: 'Assistant',  href: '/admin/assistant' },
  { label: 'System',     href: '/admin/system' },
  { label: 'Settings',   href: '/admin/settings' },
]

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) redirect('/login')

  // Verify super_admin (defence-in-depth; middleware also checks)
  const { data: memberships } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('role', 'super_admin')

  if (!memberships || memberships.length === 0) redirect('/dashboard')

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      {/* 2px amber top border */}
      <div className="h-0.5 bg-amber-500 w-full fixed top-0 left-0 z-50" />

      {/* Top navigation bar */}
      <nav className="fixed top-0.5 left-0 right-0 z-40 h-11 bg-zinc-900 border-b border-zinc-800 flex items-center px-4 gap-1">
        {/* Wordmark + Admin badge */}
        <Link href="/admin" className="flex items-center gap-2 mr-3 shrink-0">
          <span className="font-bold text-sm">
            <span className="text-amber-400">nav</span>
            <span className="text-white/50">hub</span>
          </span>
          <span className="text-[11px] font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/40 tracking-wide">
            ADMIN
          </span>
        </Link>

        {/* Nav links */}
        <div className="flex items-center gap-0.5 text-sm flex-1 overflow-x-auto">
          {NAV_LINKS.map(({ label, href }) => {
            // Insert the live Feedback badge link between Sage and Audit so
            // it appears in the same visual position as the other top-level
            // entries while keeping the unread count reactive.
            return (
              <span key={href} className="contents">
                {href === '/admin/audit' && <AdminFeedbackNavLink />}
                <Link
                  href={href}
                  className="px-3 py-1.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors whitespace-nowrap"
                >
                  {label}
                </Link>
              </span>
            )
          })}
        </div>

        {/* Exit Admin */}
        <Link
          href="/dashboard"
          className="shrink-0 text-xs text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 px-3 py-1 rounded transition-colors"
        >
          Exit Admin
        </Link>
      </nav>

      {/* Page content — offset for fixed nav (0.5px border + 44px bar) */}
      <div className="pt-12 min-h-screen">
        {children}
      </div>

      {/* Floating AI Assistant */}
      <AssistantButton isAdmin />
    </div>
  )
}
