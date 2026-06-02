import { NextResponse }      from 'next/server'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

async function verifySuperAdmin(userId: string): Promise<boolean> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('user_groups')
    .select('role')
    .eq('user_id', userId)
    .eq('role', 'super_admin')
  return (data?.length ?? 0) > 0
}

// ── GET /api/admin/suggestions ──────────────────────────────────────────────
// Lists all user_suggestions, support_requests, and feature_suggestions with
// submitter email + group name resolved. Normalizes each to a common shape.
// Supports `status` filter (comma-separated; default = open statuses).
//
// Response also includes `unread_count` — count of `submitted` rows the
// admin sidebar uses for its red badge.
export async function GET(request: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!await verifySuperAdmin(session.user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const url = new URL(request.url)
  const statusParam = url.searchParams.get('status')
  const statuses = statusParam
    ? statusParam.split(',').filter(Boolean)
    : ['submitted', 'triaged', 'acknowledged', 'acting']

  const admin = createAdminClient()

  // ── Fetch user_suggestions ────────────────────────────────────────────────
  const { data: suggestions, error } = await admin
    .from('user_suggestions')
    .select('*')
    .in('status', statuses)
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // ── Fetch support_requests ─────────────────────────────────────────────────
  // Support requests only have 'open' status, which maps to 'submitted'
  // Only fetch if the filter includes 'submitted' or 'triaged' (or default open statuses)
  const shouldFetchSupport = statuses.includes('submitted') ||
                             statuses.includes('triaged') ||
                             statuses.includes('acknowledged') ||
                             statuses.includes('acting')
  const { data: supportRequests } = shouldFetchSupport
    ? await admin
        .from('support_requests')
        .select('*')
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(200)
    : { data: [] }

  // ── Fetch feature_suggestions ──────────────────────────────────────────────
  // Feature suggestions only have 'new' status, which maps to 'submitted'
  // Only fetch if the filter includes 'submitted' or 'triaged' (or default open statuses)
  const shouldFetchFeatures = statuses.includes('submitted') ||
                              statuses.includes('triaged') ||
                              statuses.includes('acknowledged') ||
                              statuses.includes('acting')
  const { data: featureSuggestions } = shouldFetchFeatures
    ? await admin
        .from('feature_suggestions')
        .select('*')
        .eq('status', 'new')
        .order('created_at', { ascending: false })
        .limit(200)
    : { data: [] }

  // ── Normalize all rows to common shape ─────────────────────────────────────
  interface NormalizedSuggestion {
    id:            string
    created_at:    string
    submitted_by:  string | null
    what_trying:   string
    what_happened: string
    what_wanted:   string
    status:        string
    group_id:      string | null
    type:          'feedback' | 'support_request' | 'feature_suggestion'
    category?:     string | null
    sage_triage?:  Record<string, unknown> | null
    operator_note?: string | null
    user_notified_at?: string | null
    sage_finding_id?: string | null
  }

  const normalizedSuggestions: NormalizedSuggestion[] = (suggestions ?? []).map(s => {
    const row = s as Record<string, unknown>
    return {
      id:              row.id as string,
      created_at:      row.created_at as string,
      submitted_by:    row.submitted_by as string | null,
      what_trying:     row.what_trying as string,
      what_happened:   row.what_happened as string,
      what_wanted:     row.what_wanted as string,
      status:          row.status as string,
      group_id:        row.group_id as string | null,
      type:            'feedback' as const,
      category:        row.category as string | null,
      sage_triage:     row.sage_triage as Record<string, unknown> | null,
      operator_note:   row.operator_note as string | null,
      user_notified_at: row.user_notified_at as string | null,
      sage_finding_id: row.sage_finding_id as string | null,
    }
  })

  const normalizedSupport: NormalizedSuggestion[] = (supportRequests ?? []).map(s => {
    const row = s as Record<string, unknown>
    return {
      id:            row.id as string,
      created_at:    row.created_at as string,
      submitted_by:  row.user_id as string | null,
      what_trying:   'Get support',
      what_happened: row.message as string,
      what_wanted:   'Resolution',
      status:        row.status === 'open' ? 'submitted' : row.status as string,
      group_id:      row.group_id as string | null,
      type:          'support_request' as const,
    }
  })

  const normalizedFeatures: NormalizedSuggestion[] = (featureSuggestions ?? []).map(s => {
    const row = s as Record<string, unknown>
    return {
      id:            row.id as string,
      created_at:    row.created_at as string,
      submitted_by:  row.user_id as string | null,
      what_trying:   'Suggest a feature',
      what_happened: 'N/A',
      what_wanted:   row.suggestion as string,
      status:        row.status === 'new' ? 'submitted' : row.status as string,
      group_id:      row.group_id as string | null,
      type:          'feature_suggestion' as const,
    }
  })

  // ── Union and sort by created_at ────────────────────────────────────────────
  const allSuggestions = [
    ...normalizedSuggestions,
    ...normalizedSupport,
    ...normalizedFeatures,
  ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  // ── Resolve submitter emails + group names ─────────────────────────────────
  const submitterIds = Array.from(new Set(allSuggestions
    .map(s => s.submitted_by)
    .filter((x): x is string => !!x)))
  const groupIds = Array.from(new Set(allSuggestions
    .map(s => s.group_id)
    .filter((x): x is string => !!x)))

  const emailMap: Record<string, string> = {}
  if (submitterIds.length > 0) {
    const { data: userList } = await admin.auth.admin.listUsers({ perPage: 1000 })
    for (const u of userList?.users ?? []) {
      if (submitterIds.includes(u.id) && u.email) emailMap[u.id] = u.email
    }
  }

  const groupMap: Record<string, string> = {}
  if (groupIds.length > 0) {
    const { data: groups } = await admin
      .from('groups')
      .select('id, name')
      .in('id', groupIds)
    for (const g of (groups ?? []) as Array<{ id: string; name: string }>) {
      groupMap[g.id] = g.name
    }
  }

  const enriched = allSuggestions.map(s => ({
    ...s,
    submitter_email: s.submitted_by ? (emailMap[s.submitted_by] ?? null) : null,
    group_name:      s.group_id     ? (groupMap[s.group_id]      ?? null) : null,
  }))

  // Always-fresh unread count (independent of the filter param) so the
  // sidebar badge stays accurate even when the page filter is set.
  const { count: unreadCount } = await admin
    .from('user_suggestions')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'submitted')

  return NextResponse.json({ data: enriched, unread_count: unreadCount ?? 0 })
}
