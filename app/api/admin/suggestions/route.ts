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
// Lists all feedback from three sources: user_suggestions, support_requests,
// and feature_suggestions. Unifies them into a common shape with a `type` field.
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

  // Query all three feedback tables in parallel
  const [userSuggestionsResult, supportRequestsResult, featureSuggestionsResult] = await Promise.all([
    // 1. user_suggestions (existing table)
    admin
      .from('user_suggestions')
      .select('*')
      .in('status', statuses)
      .order('created_at', { ascending: false })
      .limit(100),

    // 2. support_requests
    admin
      .from('support_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100),

    // 3. feature_suggestions
    admin
      .from('feature_suggestions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100),
  ])

  if (userSuggestionsResult.error && supportRequestsResult.error && featureSuggestionsResult.error) {
    return NextResponse.json({ error: 'Failed to fetch feedback' }, { status: 500 })
  }

  // Normalize all three tables to a common shape with type discriminator
  const userSuggestions = ((userSuggestionsResult.data ?? []) as Record<string, unknown>[]).map(s => ({
    ...s,
    type: 'feedback' as const,
    // Already has: id, group_id, submitted_by (user_id), what_trying, what_happened, what_wanted, status, created_at, etc.
  }))

  const supportRequests = ((supportRequestsResult.data ?? []) as Record<string, unknown>[]).map(s => ({
    id: s.id,
    type: 'support_request' as const,
    group_id: s.group_id,
    submitted_by: s.user_id, // Normalize user_id -> submitted_by
    what_trying: 'N/A',
    what_happened: s.message ?? '',
    what_wanted: 'Support assistance',
    status: s.status ?? 'open',
    created_at: s.created_at,
    category: null,
    sage_triage: null,
    operator_note: null,
    user_notified_at: null,
    sage_finding_id: null,
    // Store original email for display
    _original_email: s.email,
  }))

  const featureSuggestions = ((featureSuggestionsResult.data ?? []) as Record<string, unknown>[]).map(s => ({
    id: s.id,
    type: 'feature_suggestion' as const,
    group_id: s.group_id,
    submitted_by: s.user_id, // Normalize user_id -> submitted_by
    what_trying: 'Suggesting a feature',
    what_happened: 'N/A',
    what_wanted: s.suggestion ?? '',
    status: s.status ?? 'new',
    created_at: s.created_at,
    category: null,
    sage_triage: null,
    operator_note: null,
    user_notified_at: null,
    sage_finding_id: null,
    // Store original email for display
    _original_email: s.email,
  }))

  // Combine and sort by created_at
  const allFeedback = [...userSuggestions, ...supportRequests, ...featureSuggestions]
  allFeedback.sort((a, b) => {
    const timeA = new Date(a.created_at as string).getTime()
    const timeB = new Date(b.created_at as string).getTime()
    return timeB - timeA // newest first
  })

  const suggestions = allFeedback.slice(0, 200) as Record<string, unknown>[]

  // Resolve submitter emails + group names so the UI doesn't need to chain
  // requests. One pass each — small lists in practice.
  const submitterIds = Array.from(new Set(((suggestions ?? []) as Array<{ submitted_by: string | null }>)
    .map(s => s.submitted_by)
    .filter((x): x is string => !!x)))
  const groupIds = Array.from(new Set(((suggestions ?? []) as Array<{ group_id: string | null }>)
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

  const enriched = (suggestions ?? []).map(s => {
    const r = s as Record<string, unknown> & {
      submitted_by: string | null
      group_id: string | null
      _original_email?: string | null
    }
    return {
      ...r,
      // For support_requests and feature_suggestions, use _original_email if submitted_by is null
      submitter_email: r.submitted_by
        ? (emailMap[r.submitted_by] ?? null)
        : (r._original_email ?? null),
      group_name: r.group_id ? (groupMap[r.group_id] ?? null) : null,
    }
  })

  // Always-fresh unread count (independent of the filter param) so the
  // sidebar badge stays accurate even when the page filter is set.
  const { count: unreadCount } = await admin
    .from('user_suggestions')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'submitted')

  return NextResponse.json({ data: enriched, unread_count: unreadCount ?? 0 })
}
