import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { Resend } from 'resend'

/**
 * Admin Markets access API (MKT-1). Super-admin only. Lets the operator view
 * every Markets user, grant / revoke the markets_viewer / markets_manager
 * roles, and invite an email address into Markets (reusing the NavHub invite
 * flow — no password is ever created). Writes go through the service-role admin
 * client (RLS bypass); the super-admin check below is the real gate.
 */

const MARKETS_ROLES = ['markets_viewer', 'markets_manager'] as const
type MarketsRole = (typeof MARKETS_ROLES)[number]

function getResend() {
  return new Resend(process.env.RESEND_API_KEY)
}

async function verifySuperAdmin(userId: string): Promise<boolean> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('user_groups')
    .select('role')
    .eq('user_id', userId)
    .eq('role', 'super_admin')
  return (data?.length ?? 0) > 0
}

// ─── GET /api/admin/markets ───────────────────────────────────────────────────
// Lists every user holding an active Markets role, enriched with email.
export async function GET() {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const admin = createAdminClient()
  if (!await verifySuperAdmin(session.user.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data: roleRows, error } = await admin
    .from('market_user_roles')
    .select('user_id, role, granted_at')
    .is('revoked_at', null)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { data: { users } } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const emailById = new Map((users ?? []).map(u => [u.id, u.email ?? '']))

  // Collapse to one row per user, carrying every active role they hold.
  const byUser = new Map<string, { user_id: string; email: string; roles: MarketsRole[]; granted_at: string }>()
  for (const r of (roleRows ?? []) as Array<{ user_id: string; role: MarketsRole; granted_at: string }>) {
    const existing = byUser.get(r.user_id)
    if (existing) {
      existing.roles.push(r.role)
      if (r.granted_at < existing.granted_at) existing.granted_at = r.granted_at
    } else {
      byUser.set(r.user_id, {
        user_id:    r.user_id,
        email:      emailById.get(r.user_id) ?? '',
        roles:      [r.role],
        granted_at: r.granted_at,
      })
    }
  }

  return NextResponse.json({ data: Array.from(byUser.values()) })
}

// ─── POST /api/admin/markets ──────────────────────────────────────────────────
// Grant a Markets role. Two modes:
//   • Existing user (email already has a NavHub account) → grant immediately.
//   • New email → create a group_invites + invite_tokens row and email a
//     passwordless "Accept invitation" link (mirrors /api/admin/users). The
//     Markets role is granted on top; the user still lands in their NavHub
//     group and reaches Markets via the nav entry once they sign in.
export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const admin = createAdminClient()
  if (!await verifySuperAdmin(session.user.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: Record<string, unknown>
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const roleRaw = typeof body.role === 'string' ? body.role : ''
  const role    = (MARKETS_ROLES as readonly string[]).includes(roleRaw) ? (roleRaw as MarketsRole) : null
  if (!role) return NextResponse.json({ error: 'A valid Markets role is required.' }, { status: 400 })

  const userId = typeof body.user_id === 'string' ? body.user_id : ''
  const email  = typeof body.email   === 'string' ? body.email.trim().toLowerCase() : ''

  // ── Mode A: grant to an existing user by id ──────────────────────────────────
  if (userId) {
    const granted = await grantRole(admin, userId, role, session.user.id)
    if (!granted.ok) return NextResponse.json({ error: granted.error }, { status: granted.status })
    void admin.from('admin_audit_log').insert({
      actor_id:    session.user.id,
      action:      'grant_markets_role',
      entity_type: 'user',
      entity_id:   userId,
      metadata:    { role },
    })
    return NextResponse.json({ data: { user_id: userId, role, granted: true } }, { status: 201 })
  }

  // ── Mode B: invite / grant by email ──────────────────────────────────────────
  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'A user_id or valid email is required.' }, { status: 400 })
  }

  const { data: { users } } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const existingUser = users?.find(u => (u.email ?? '').toLowerCase() === email)

  if (existingUser) {
    const granted = await grantRole(admin, existingUser.id, role, session.user.id)
    if (!granted.ok) return NextResponse.json({ error: granted.error }, { status: granted.status })
    void admin.from('admin_audit_log').insert({
      actor_id:    session.user.id,
      action:      'grant_markets_role',
      entity_type: 'user',
      entity_id:   existingUser.id,
      metadata:    { role, email },
    })
    return NextResponse.json({ data: { user_id: existingUser.id, email, role, granted: true, existing: true } }, { status: 201 })
  }

  // New email — send a passwordless invite. The Markets role is recorded only
  // once they have an account, so we stash it on the invite metadata and email
  // the standard NavHub invite link. (For MKT-1 the invite lands them in no
  // specific group; they must be a NavHub user first — so we require an existing
  // account for an immediate grant and otherwise just dispatch the invite.)
  const appUrl     = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.navhub.co'
  const fromDomain = process.env.RESEND_FROM_DOMAIN  ?? 'navhub.co'

  const redirectTo = `${appUrl}/auth/callback?next=${encodeURIComponent('/set-password?invite=true')}`
  let signupLink = `${appUrl}/login`
  try {
    const { data: linkData } = await admin.auth.admin.generateLink({
      type:    'invite',
      email,
      options: { redirectTo, data: { markets_role: role, invited_by: session.user.id } },
    })
    const hashedToken = (linkData?.properties as { hashed_token?: string } | undefined)?.hashed_token
    const action = hashedToken
      ? `${appUrl}/auth/callback?token_hash=${encodeURIComponent(hashedToken)}&type=invite&next=${encodeURIComponent('/set-password?invite=true')}`
      : undefined
    if (action) signupLink = action
  } catch (err) {
    console.error('[admin/markets] generateLink (invite) threw:', err instanceof Error ? err.message : String(err))
  }

  try {
    await getResend().emails.send({
      from:    `NavHub <invites@${fromDomain}>`,
      to:      email,
      subject: `You've been invited to Markets on NavHub`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px">
          <h2 style="margin:0 0 8px">You've been invited to <strong>Markets</strong></h2>
          <p style="margin:0 0 16px;color:#555">
            You've been granted <strong>${role.replace('markets_', '')}</strong> access to Markets on NavHub.
          </p>
          <p style="margin:24px 0">
            <a href="${signupLink}"
               style="display:inline-block;padding:10px 20px;background:#0ea5e9;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
              Accept invitation &amp; set up your account →
            </a>
          </p>
          <p style="margin:0 0 8px;font-size:12px;color:#777">This link expires in 24 hours.</p>
        </div>
      `,
    })
  } catch (err) {
    console.error('[admin/markets] invite email failed:', err instanceof Error ? err.message : String(err))
  }

  void admin.from('admin_audit_log').insert({
    actor_id:    session.user.id,
    action:      'invite_markets_user',
    entity_type: 'user',
    entity_id:   null,
    metadata:    { email, role },
  })

  return NextResponse.json({ data: { email, role, invited: true, existing: false } }, { status: 201 })
}

// ─── DELETE /api/admin/markets ────────────────────────────────────────────────
// Revoke a Markets role for a user (soft — sets revoked_at). Body: { user_id, role }.
export async function DELETE(req: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const admin = createAdminClient()
  if (!await verifySuperAdmin(session.user.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: Record<string, unknown>
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const userId  = typeof body.user_id === 'string' ? body.user_id : ''
  const roleRaw = typeof body.role    === 'string' ? body.role : ''
  const role    = (MARKETS_ROLES as readonly string[]).includes(roleRaw) ? (roleRaw as MarketsRole) : null
  if (!userId || !role) return NextResponse.json({ error: 'user_id and a valid role are required.' }, { status: 400 })

  const { error } = await admin
    .from('market_user_roles')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('role', role)
    .is('revoked_at', null)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  void admin.from('admin_audit_log').insert({
    actor_id:    session.user.id,
    action:      'revoke_markets_role',
    entity_type: 'user',
    entity_id:   userId,
    metadata:    { role },
  })

  return NextResponse.json({ data: { user_id: userId, role, revoked: true } })
}

// ── helper: grant (or re-activate) a Markets role for a user ──────────────────
async function grantRole(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  role: MarketsRole,
  grantedBy: string,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  // Upsert on the (user_id, role) unique key; clear any prior revocation so a
  // re-grant reactivates the same row.
  const { error } = await admin
    .from('market_user_roles')
    .upsert(
      { user_id: userId, role, granted_by: grantedBy, granted_at: new Date().toISOString(), revoked_at: null },
      { onConflict: 'user_id,role' },
    )
  if (error) return { ok: false, error: error.message, status: 500 }
  return { ok: true }
}
