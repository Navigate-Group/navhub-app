import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildUsageReport } from '@/lib/markets/usage'

export const runtime = 'nodejs'

/**
 * Admin Markets usage API (MKT-8). Super-admin only. Returns token counts by
 * user and by agent (Market Analyst from market_analyst_runs, Document Extractor
 * from markets_agent_runs), with per-user today totals vs. the cap and alert
 * threshold. `window` (days) restricts the aggregate totals; `all` = all time.
 */

async function verifySuperAdmin(userId: string): Promise<boolean> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('user_groups')
    .select('role')
    .eq('user_id', userId)
    .eq('role', 'super_admin')
  return (data?.length ?? 0) > 0
}

export async function GET(req: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!await verifySuperAdmin(session.user.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const windowParam = new URL(req.url).searchParams.get('window')
  const windowDays =
    windowParam === 'all'
      ? null
      : Math.min(365, Math.max(1, parseInt(windowParam ?? '30', 10) || 30))

  const report = await buildUsageReport(windowDays)
  return NextResponse.json({ data: report })
}
