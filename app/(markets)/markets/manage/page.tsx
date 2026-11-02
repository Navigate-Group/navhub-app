import { redirect }    from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getMarketsAccess, canManageMarkets } from '@/lib/markets'
import { Settings2 } from 'lucide-react'

/**
 * Markets curation surface (MKT-1 shell). Managers only — middleware enforces
 * a hard 403 for non-managers; this server check is defence-in-depth.
 */
export default async function MarketsManagePage() {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) redirect('/login')

  const access = await getMarketsAccess(supabase, session.user.id)
  if (!canManageMarkets(access)) redirect('/markets')

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-muted">
          <Settings2 className="h-6 w-6 text-foreground" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Manage Markets</h1>
          <p className="text-sm text-muted-foreground">Curation surfaces for Markets managers.</p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-6">
        <p className="text-sm text-muted-foreground">
          Curation tools will appear here in a later phase.
        </p>
      </div>
    </div>
  )
}
