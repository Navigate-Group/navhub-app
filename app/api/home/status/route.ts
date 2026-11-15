import { NextResponse } from 'next/server'
import { cookies }      from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { getMarketsAccess, canViewMarkets } from '@/lib/markets'

// ─── GET /api/home/status ─────────────────────────────────────────────────────
// Lightweight connection-state + inventory summary for the home page tiles.
// Returns:
//   {
//     xero_connected:      boolean  — any Xero connection for a group company/division
//     marketing_connected: boolean  — any active marketing connection for the group
//     agent_count:         number   — active agents visible in the active group
//     document_count:      number   — documents in the active group
//   }
export async function GET() {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }
  if (!activeGroupId) {
    return NextResponse.json({ error: 'No active group' }, { status: 400 })
  }

  // ── Group companies (for Xero connection lookup) ────────────────────────────
  const { data: companies } = await supabase
    .from('companies')
    .select('id')
    .eq('group_id', activeGroupId)
    .eq('is_active', true)

  const companyIds = (companies ?? []).map(c => c.id)

  // Divisions under those companies
  const { data: divisions } = companyIds.length > 0
    ? await supabase
        .from('divisions')
        .select('id')
        .in('company_id', companyIds)
        .eq('is_active', true)
    : { data: [] }

  const divisionIds = (divisions ?? []).map(d => d.id)

  // ── Xero connection state ───────────────────────────────────────────────────
  let xeroConnected = false
  if (companyIds.length > 0) {
    const filters: string[] = []
    if (companyIds.length > 0)  filters.push(`company_id.in.(${companyIds.join(',')})`)
    if (divisionIds.length > 0) filters.push(`division_id.in.(${divisionIds.join(',')})`)

    if (filters.length > 0) {
      const { data: xeroConn } = await supabase
        .from('xero_connections')
        .select('id')
        .or(filters.join(','))
        .limit(1)
      xeroConnected = (xeroConn?.length ?? 0) > 0
    }
  }

  // ── Marketing connection state ──────────────────────────────────────────────
  const { data: marketingConn } = await supabase
    .from('marketing_connections')
    .select('id')
    .eq('group_id', activeGroupId)
    .eq('is_active', true)
    .limit(1)
  const marketingConnected = (marketingConn?.length ?? 0) > 0

  // ── Inventory counts ────────────────────────────────────────────────────────
  const { count: agentCount } = await supabase
    .from('agents')
    .select('id', { count: 'exact', head: true })
    .eq('group_id', activeGroupId)
    .eq('is_active', true)

  const { count: documentCount } = await supabase
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('group_id', activeGroupId)

  // ── Markets visibility (role-gated, independent of active group) ─────────────
  let marketsVisible = false
  try {
    const marketsAccess = await getMarketsAccess(supabase, session.user.id)
    marketsVisible = canViewMarkets(marketsAccess)
  } catch { /* default hidden */ }

  return NextResponse.json({
    xero_connected:      xeroConnected,
    marketing_connected: marketingConnected,
    agent_count:         agentCount ?? 0,
    document_count:      documentCount ?? 0,
    markets_visible:     marketsVisible,
  })
}
