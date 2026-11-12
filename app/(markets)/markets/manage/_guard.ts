import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getMarketsAccess, canManageMarkets } from '@/lib/markets'

/**
 * Server-side manager gate for the Markets curation pages (MKT-6).
 * Middleware already hard-403s non-managers on /markets/manage/*; this is
 * defence-in-depth for the Server Components. Viewers are redirected to the
 * read-only explorer.
 */
export async function requireManagerPage(): Promise<void> {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) redirect('/login')
  const access = await getMarketsAccess(supabase, session.user.id)
  if (!canManageMarkets(access)) redirect('/markets')
}
