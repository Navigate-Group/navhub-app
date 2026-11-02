import { NextResponse }      from 'next/server'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

/**
 * POST /api/dev/seed-markets-fixture  (MKT-1 fixture — dev only)
 *
 * Promotes two PRE-EXISTING NavHub users to Markets roles so the gating can be
 * exercised end-to-end:
 *   • first email  → markets_viewer
 *   • second email → markets_manager
 *
 * Both must already be NavHub users with groups (the brief's premise). Emails
 * come from the request body `{ viewer_email, manager_email }` or fall back to
 * MARKETS_FIXTURE_VIEWER_EMAIL / MARKETS_FIXTURE_MANAGER_EMAIL.
 *
 * Idempotent: re-grants reactivate the same market_user_roles row. Super-admin
 * only, and returns 404 in production.
 */
export async function POST(req: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const admin = createAdminClient()

  // Super-admin gate (defence-in-depth; /api/dev is not public in middleware).
  const { data: superRows } = await admin
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('role', 'super_admin')
    .limit(1)
  if ((superRows?.length ?? 0) === 0) {
    return NextResponse.json({ error: 'Super admin required' }, { status: 403 })
  }

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* body optional */ }

  const viewerEmail  = String(
    (typeof body.viewer_email  === 'string' && body.viewer_email)  ||
    process.env.MARKETS_FIXTURE_VIEWER_EMAIL  || '',
  ).trim().toLowerCase()
  const managerEmail = String(
    (typeof body.manager_email === 'string' && body.manager_email) ||
    process.env.MARKETS_FIXTURE_MANAGER_EMAIL || '',
  ).trim().toLowerCase()

  if (!viewerEmail || !managerEmail) {
    return NextResponse.json(
      { error: 'Provide viewer_email and manager_email (body) or set MARKETS_FIXTURE_VIEWER_EMAIL / MARKETS_FIXTURE_MANAGER_EMAIL.' },
      { status: 400 },
    )
  }

  const { data: { users } } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const findUser = (email: string) => users?.find(u => (u.email ?? '').toLowerCase() === email)

  const results: Array<{ email: string; role: string; granted: boolean; note?: string }> = []

  for (const [email, role] of [
    [viewerEmail,  'markets_viewer']  as const,
    [managerEmail, 'markets_manager'] as const,
  ]) {
    const user = findUser(email)
    if (!user) {
      results.push({ email, role, granted: false, note: 'User not found — must be a pre-existing NavHub user.' })
      continue
    }
    // Confirm the user actually has a group membership (the brief's premise).
    const { data: groups } = await admin
      .from('user_groups')
      .select('group_id')
      .eq('user_id', user.id)
      .limit(1)
    if ((groups?.length ?? 0) === 0) {
      results.push({ email, role, granted: false, note: 'User has no group membership.' })
      continue
    }

    const { error } = await admin
      .from('market_user_roles')
      .upsert(
        { user_id: user.id, role, granted_by: session.user.id, granted_at: new Date().toISOString(), revoked_at: null },
        { onConflict: 'user_id,role' },
      )
    results.push({ email, role, granted: !error, note: error?.message })
  }

  return NextResponse.json({ data: { results } })
}
