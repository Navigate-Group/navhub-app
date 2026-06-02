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
// Lists all feedback from user_suggestions, support_requests, and feature_suggestions
// with submitter email + group name resolved.
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
    : ['submitted', 'triaged', 'acknowledged', 'acting', 'open', 'new']

  const admin = createAdminClient()

  // Map statuses for different tables
  // user_suggestions: submitted, triaged, acknowledged, acting, declined, shipped
  // support_requests: open (default), or any status updated by admin
  // feature_suggestions: new (default), or any status updated by admin

  // For 'open' filter, include submitted/open/new (all unprocessed items)
  const includeOpenStatuses = statuses.includes('open') ||
                               statuses.includes('submitted') ||
                               statuses.includes('triaged') ||
                               statuses.includes('acknowledged') ||
                               statuses.includes('acting')

  // Fetch from user_suggestions
  let userSuggestionsQuery = admin.from('user_suggestions').select('*')
  if (includeOpenStatuses && !statusParam) {
    // Default: show open items
    userSuggestionsQuery = userSuggestionsQuery.in('status', ['submitted', 'triaged', 'acknowledged', 'acting'])
  } else if (statuses.length > 0) {
    userSuggestionsQuery = userSuggestionsQuery.in('status', statuses)
  }
  const { data: userSuggestions, error: userSugError } = await userSuggestionsQuery
  if (userSugError) return NextResponse.json({ error: userSugError.message }, { status: 500 })

  // Fetch from support_requests - include if we're showing open items
  let supportRequests: unknown[] = []
  if (includeOpenStatuses || statuses.includes('open') || statuses.includes('all')) {
    const { data, error: supportError } = await admin
      .from('support_requests')
      .select('*')
    if (supportError) return NextResponse.json({ error: supportError.message }, { status: 500 })
    supportRequests = data ?? []
  }

  // Fetch from feature_suggestions - include if we're showing new/open items
  let featureSuggestions: unknown[] = []
  if (includeOpenStatuses || statuses.includes('new') || statuses.includes('all')) {
    const { data, error: featureError } = await admin
      .from('feature_suggestions')
      .select('*')
    if (featureError) return NextResponse.json({ error: featureError.message }, { status: 500 })
    featureSuggestions = data ?? []
  }

  // Normalize and combine all three sources with type field
  const normalizedUserSuggestions = (userSuggestions ?? []).map((s: Record<string, unknown>) => ({
    ...s,
    type: 'feedback' as const,
    submitted_by: s.submitted_by,
  }))

  const normalizedSupportRequests = (supportRequests ?? []).map((s: Record<string, unknown>) => ({
    ...s,
    type: 'support_request' as const,
    submitted_by: s.user_id,
    what_trying: s.message || '',
    what_happened: s.message || '',
    what_wanted: s.message || '',
  }))

  const normalizedFeatureSuggestions = (featureSuggestions ?? []).map((s: Record<string, unknown>) => ({
    ...s,
    type: 'feature_suggestion' as const,
    submitted_by: s.user_id,
    what_trying: s.suggestion || '',
    what_happened: s.suggestion || '',
    what_wanted: s.suggestion || '',
  }))

  // Combine all sources
  const allSuggestions = [
    ...normalizedUserSuggestions,
    ...normalizedSupportRequests,
    ...normalizedFeatureSuggestions,
  ].sort((a, b) => new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime())
    .slice(0, 200)

  // Resolve submitter emails + group names so the UI doesn't need to chain
  // requests. One pass each — small lists in practice.
  const submitterIds = Array.from(new Set(allSuggestions
    .map(s => s.submitted_by as string | null)
    .filter((x): x is string => !!x)))
  const groupIds = Array.from(new Set(allSuggestions
    .map(s => s.group_id as string | null)
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

  const enriched = allSuggestions.map(s => {
    const submitterId = s.submitted_by as string | null
    const groupId = s.group_id as string | null
    return {
      ...s,
      submitter_email: submitterId ? (emailMap[submitterId] ?? s.email ?? null) : (s.email ?? null),
      group_name:      groupId     ? (groupMap[groupId]      ?? null) : null,
    }
  })

  // Always-fresh unread count (independent of the filter param) so the
  // sidebar badge stays accurate even when the page filter is set.
  const { count: userSugCount } = await admin
    .from('user_suggestions')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'submitted')
  const { count: supportCount } = await admin
    .from('support_requests')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'open')
  const { count: featureCount } = await admin
    .from('feature_suggestions')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'new')

  const unreadCount = (userSugCount ?? 0) + (supportCount ?? 0) + (featureCount ?? 0)

  return NextResponse.json({ data: enriched, unread_count: unreadCount })
}
