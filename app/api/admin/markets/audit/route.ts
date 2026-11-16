import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

/**
 * Admin Markets audit API (MKT-8). Super-admin only. Queries the immutable
 * markets_audit log (migration 075/077) — the trail that observation approvals,
 * supersedes (recorded as action='archive' with a note) and markets_documents
 * changes write to. Filterable by actor (user), date range, target table and
 * action. Paginated and enriched with actor emails.
 *
 * NOTE: the brief lists actions "insert / update / supersede". The real log's
 * action vocabulary (migration 075 CHECK) is insert / update / archive /
 * restore / delete — a supersede is recorded as an 'archive' of the prior row
 * (with a "superseded by…" note) plus an 'insert' of the new row. The filter
 * exposes the real actions; 'supersede' is surfaced via the archive+note.
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

  const sp = new URL(req.url).searchParams
  const page   = Math.max(1, parseInt(sp.get('page')  ?? '1', 10) || 1)
  const limit  = Math.min(100, Math.max(1, parseInt(sp.get('limit') ?? '50', 10) || 50))
  const actor  = sp.get('actor_id')     // user filter
  const table  = sp.get('target_table') // table filter
  const action = sp.get('action')       // insert | update | archive | restore | delete
  const from   = sp.get('from')         // ISO date (inclusive)
  const to     = sp.get('to')           // ISO date (exclusive upper bound handled below)
  const offset = (page - 1) * limit

  const admin = createAdminClient()

  let query = admin
    .from('markets_audit')
    .select('id, actor_id, action, target_table, row_id, old_value, new_value, note, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (actor)  query = query.eq('actor_id', actor)
  if (table)  query = query.eq('target_table', table)
  if (action) query = query.eq('action', action)
  if (from)   query = query.gte('created_at', from)
  if (to) {
    // Treat `to` as an inclusive day: add a day so the whole day is covered.
    const toDate = new Date(to)
    if (!Number.isNaN(toDate.getTime())) {
      toDate.setUTCDate(toDate.getUTCDate() + 1)
      query = query.lt('created_at', toDate.toISOString())
    }
  }

  const { data: rows, count, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  type AuditRow = {
    id: string; actor_id: string | null; action: string
    target_table: string; row_id: string
    old_value: Record<string, unknown> | null
    new_value: Record<string, unknown> | null
    note: string | null; created_at: string
  }

  const entries = (rows ?? []) as AuditRow[]

  // Enrich with actor emails.
  const actorIds = Array.from(new Set(entries.map(e => e.actor_id).filter(Boolean) as string[]))
  const emailById: Record<string, string> = {}
  if (actorIds.length > 0) {
    try {
      const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
      for (const u of data?.users ?? []) {
        if (actorIds.includes(u.id)) emailById[u.id] = u.email ?? u.id
      }
    } catch {
      /* best-effort email enrichment */
    }
  }

  const data = entries.map(e => ({
    ...e,
    actor_email: e.actor_id ? (emailById[e.actor_id] ?? e.actor_id) : null,
  }))

  // Distinct target tables present (for the filter dropdown).
  return NextResponse.json({
    data,
    pagination: { page, limit, total: count ?? 0, pages: Math.ceil((count ?? 0) / limit) },
  })
}
