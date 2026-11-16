import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

/**
 * Admin Markets audit API (MKT-8). Super-admin only. Backs the
 * /admin/markets/audit page: the immutable log of every Markets reference-data
 * change (markets_audit, migration 075) — who changed what table / row, when,
 * and the before / after values. Reads via the service-role client; the
 * super-admin check below is the real gate.
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

interface AuditRow {
  id:           string
  actor_id:     string | null
  action:       string
  target_table: string
  row_id:       string
  old_value:    Record<string, unknown> | null
  new_value:    Record<string, unknown> | null
  note:         string | null
  created_at:   string
}

// ─── GET /api/admin/markets/audit ─────────────────────────────────────────────
// Query params: page, limit (max 100), action, target_table
export async function GET(req: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!await verifySuperAdmin(session.user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const page   = Math.max(1, parseInt(searchParams.get('page')  ?? '1', 10))
  const limit  = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10)))
  const action = searchParams.get('action')
  const table  = searchParams.get('target_table')
  const offset = (page - 1) * limit

  const admin = createAdminClient()

  let query = admin
    .from('markets_audit')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (action) query = query.eq('action', action)
  if (table)  query = query.eq('target_table', table)

  const { data: entries, count, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (entries ?? []) as AuditRow[]

  // Enrich with actor emails.
  const actorIds = Array.from(new Set(rows.map(e => e.actor_id).filter(Boolean) as string[]))
  const emailMap: Record<string, string> = {}
  if (actorIds.length > 0) {
    const { data: { users } } = await admin.auth.admin.listUsers({ perPage: 1000 })
    for (const u of users ?? []) {
      if (actorIds.includes(u.id)) emailMap[u.id] = u.email ?? u.id
    }
  }

  const data = rows.map(e => ({
    ...e,
    actor_email: e.actor_id ? (emailMap[e.actor_id] ?? e.actor_id) : null,
  }))

  return NextResponse.json({
    data,
    pagination: { page, limit, total: count ?? 0, pages: Math.ceil((count ?? 0) / limit) },
  })
}
