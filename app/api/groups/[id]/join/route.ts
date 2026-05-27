import { NextResponse }      from 'next/server'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

const VALID_ROLES = ['super_admin', 'group_owner', 'group_admin', 'manager', 'viewer']

// ─── POST /api/groups/[id]/join ───────────────────────────────────────────────
// Called from /auth/accept-invite after the user has set their password.
// Validates a pending invite for the calling user's email, adds them to the group,
// and marks the invite accepted.
// Body: { role: string }

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const email = session.user.email
  if (!email) return NextResponse.json({ error: 'No email on session' }, { status: 400 })

  let body: Record<string, unknown>
  try { body = await request.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const role = typeof body.role === 'string' ? body.role : 'viewer'
  if (!VALID_ROLES.includes(role)) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 422 })
  }

  const admin = createAdminClient()

  // Verify a pending invite exists for this email + group
  const { data: invite, error: inviteErr } = await admin
    .from('group_invites')
    .select('id, role')
    .eq('group_id', params.id)
    .eq('email', email.toLowerCase())
    .is('accepted_at', null)
    .single()

  if (inviteErr || !invite) {
    // No pending invite — still allow joining if role matches (idempotent)
    // but use the requested role only if the invite exists
    return NextResponse.json({ error: 'No pending invite found for this email.' }, { status: 403 })
  }

  // Use the role recorded on the invite (not the query param) for security
  const assignedRole = invite.role ?? role

  // Count existing memberships to determine is_default
  const { count } = await admin
    .from('user_groups')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', session.user.id)

  const { error: upsertErr } = await admin
    .from('user_groups')
    .upsert(
      {
        user_id:    session.user.id,
        group_id:   params.id,
        role:       assignedRole,
        is_default: (count ?? 0) === 0,
      },
      { onConflict: 'user_id,group_id' }
    )

  if (upsertErr) {
    return NextResponse.json({ error: upsertErr.message }, { status: 500 })
  }

  // Mark invite accepted
  void admin
    .from('group_invites')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', invite.id)

  // Set active_group_id cookie via response so the dashboard redirect works
  const response = NextResponse.json({ success: true, group_id: params.id })
  response.cookies.set('active_group_id', params.id, {
    httpOnly: false,
    path:     '/',
    maxAge:   60 * 60 * 24 * 365,
  })
  return response
}
