import { redirect }       from 'next/navigation'
import { createClient }    from '@/lib/supabase/server'
import { getMarketsAccess, canViewMarkets, canManageMarkets, getMarketsTheme } from '@/lib/markets'
import MarketsShell        from '@/components/markets/MarketsShell'

/**
 * Markets layout (MKT-1). A deliberately slim shell — no Group or Company
 * context, no NavHub sidebar. Middleware already gates access; this is
 * defence-in-depth and also supplies the `canManage` flag to the shell so the
 * Manage link only renders for markets_manager / super admin.
 */
export default async function MarketsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) redirect('/login')

  const access = await getMarketsAccess(supabase, session.user.id)
  if (!canViewMarkets(access)) redirect('/?error=markets_access')

  // Per-user Markets theme preference (MKT-2), persisted server-side.
  const initialTheme = await getMarketsTheme(supabase, session.user.id)

  return (
    <MarketsShell
      userEmail={session.user.email ?? ''}
      canManage={canManageMarkets(access)}
      initialTheme={initialTheme}
    >
      {children}
    </MarketsShell>
  )
}
