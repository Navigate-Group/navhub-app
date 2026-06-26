import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { Resend } from 'resend'

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

// ─── GET /api/admin/users ─────────────────────────────────────────────────────
// Returns all platform users (from auth.users) enriched with group memberships.
export async function GET() {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const admin = createAdminClient()
  if (!await verifySuperAdmin(session.user.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data: { users }, error: authError } = await admin.auth.admin.listUsers({ perPage: 1000 })
  if (authError) return NextResponse.json({ error: authError.message }, { status: 500 })

  const { data: allMemberships } = await admin
    .from('user_groups')
    .select('user_id, group_id, role, is_default, group:groups(name)')

  type MembershipRow = {
    user_id:    string
    group_id:   string
    role:       string
    is_default: boolean
    group:      { name: string }[] | { name: string } | null
  }

  const memberMap: Record<string, { group_id: string; group_name: string; role: string; is_default: boolean }[]> = {}
  for (const m of (allMemberships ?? []) as unknown as MembershipRow[]) {
    if (!memberMap[m.user_id]) memberMap[m.user_id] = []
    const groupName = Array.isArray(m.group)
      ? (m.group[0]?.name ?? m.group_id)
      : (m.group?.name ?? m.group_id)
    memberMap[m.user_id].push({
      group_id:   m.group_id,
      group_name: groupName,
      role:       m.role,
      is_default: m.is_default ?? false,
    })
  }

  const data = users.map(u => ({
    id:              u.id,
    email:           u.email ?? '',
    created_at:      u.created_at,
    last_sign_in_at: u.last_sign_in_at ?? null,
    groups:          memberMap[u.id] ?? [],
  }))

  return NextResponse.json({ data })
}

// ─── POST /api/admin/users ────────────────────────────────────────────────────
// Creates a new user via the invite-link flow (NO plaintext password). Mirrors
// the proven pattern in app/api/groups/[id]/invites/route.ts:
//   • New user      → group_invites row + generateLink({ type: 'invite' }) +
//                     invite_tokens row + Resend "Accept invitation" email. The
//                     invitee sets their OWN password via /set-password.
//   • Existing user → added to the group immediately + magic-link notification.
// No password is ever created, stored, or returned.
export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const admin = createAdminClient()
  if (!await verifySuperAdmin(session.user.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: Record<string, unknown>
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  // Defence-in-depth: this endpoint no longer accepts passwords. Reject any
  // attempt to supply one so a stale client can't reintroduce the old flow.
  if ('password' in body && body.password !== undefined && body.password !== null && body.password !== '') {
    return NextResponse.json(
      { error: 'Passwords are no longer accepted. Users are invited via email and set their own password.' },
      { status: 400 },
    )
  }

  const email    = typeof body.email    === 'string' ? body.email.trim().toLowerCase() : ''
  const groupId  = typeof body.group_id === 'string' ? body.group_id : ''
  const roleRaw  = typeof body.role     === 'string' ? body.role : ''

  if (!email || !email.includes('@')) return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 })
  if (!groupId)                       return NextResponse.json({ error: 'Group is required.' }, { status: 400 })

  const validRoles = ['group_owner', 'group_admin', 'manager', 'staff', 'viewer']
  const role       = validRoles.includes(roleRaw) ? roleRaw : 'viewer'

  // Fetch the group name for email copy + validate the group exists.
  const { data: group, error: groupErr } = await admin
    .from('groups')
    .select('name')
    .eq('id', groupId)
    .single()
  if (groupErr || !group) return NextResponse.json({ error: 'Group not found.' }, { status: 404 })

  const groupName  = group.name ?? 'a NavHub group'
  const roleLabel  = role.replace(/_/g, ' ')
  const appUrl     = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.navhub.co'
  const fromDomain = process.env.RESEND_FROM_DOMAIN  ?? 'navhub.co'

  // Record the invite in DB so /auth/callback can claim it (creating the
  // user_groups membership) once the invitee accepts.
  const { data: invite, error: inviteErr } = await admin
    .from('group_invites')
    .upsert(
      {
        group_id:   groupId,
        email,
        role,
        invited_by: session.user.id,
      },
      { onConflict: 'group_id,email', ignoreDuplicates: false },
    )
    .select()
    .single()
  if (inviteErr) return NextResponse.json({ error: inviteErr.message }, { status: 500 })

  // Does this email already have a Supabase account?
  const { data: userList } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const existingUser = userList?.users.find(u => (u.email ?? '').toLowerCase() === email)

  if (!existingUser) {
    // ── NEW user — invite link (no password). Mirror the invites route. ──────
    const redirectTo = `${appUrl}/auth/callback?next=${encodeURIComponent('/set-password?invite=true')}`

    let signupLink = `${appUrl}/login`
    try {
      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
        type:    'invite',
        email,
        options: { redirectTo, data: { group_id: groupId, role, invited_by: session.user.id } },
      })
      if (linkErr) console.error('[admin/users] generateLink (invite) error:', linkErr.message)

      const hashedToken = (linkData?.properties as { hashed_token?: string } | undefined)?.hashed_token
      const action = hashedToken
        ? `${appUrl}/auth/callback?token_hash=${encodeURIComponent(hashedToken)}&type=invite&next=${encodeURIComponent('/set-password?invite=true')}`
        : undefined
      if (action) {
        // Outlook / Safe Links workaround — store the action_link, email a
        // NavHub /invite/<token> URL instead (see migration 061).
        const { data: tokenRow, error: tokenErr } = await admin
          .from('invite_tokens')
          .insert({
            invite_id:   invite.id,
            action_link: action,
            email,
            group_id:    groupId,
            group_name:  groupName,
            role,
          })
          .select('token')
          .single()
        if (tokenErr) {
          console.error('[admin/users] invite_tokens insert error:', tokenErr.message)
          signupLink = action
        } else if (tokenRow) {
          signupLink = `${appUrl}/invite/${(tokenRow as { token: string }).token}`
        }
      }
    } catch (err) {
      console.error('[admin/users] generateLink (invite) threw:', err instanceof Error ? err.message : String(err))
    }

    await getResend().emails.send({
      from:    `NavHub <invites@${fromDomain}>`,
      to:      email,
      subject: `You've been invited to join ${groupName} on NavHub`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px">
          <h2 style="margin:0 0 8px">You've been invited to <strong>${groupName}</strong></h2>
          <p style="margin:0 0 16px;color:#555">
            You've been invited to join <strong>${groupName}</strong> on NavHub as
            <strong>${roleLabel}</strong>.
          </p>
          <p style="margin:24px 0">
            <a href="${signupLink}"
               style="display:inline-block;padding:10px 20px;background:#0ea5e9;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
              Accept invitation &amp; set up your account →
            </a>
          </p>
          <p style="margin:0 0 8px;font-size:12px;color:#777">This link expires in 24 hours.</p>
          <p style="margin-top:24px;font-size:12px;color:#aaa">
            If you weren't expecting this, you can safely ignore this email.
          </p>
        </div>
      `,
    })
  } else {
    // ── EXISTING user — add to group immediately + magic-link notification. ──
    const { data: existingDefault } = await admin
      .from('user_groups')
      .select('id')
      .eq('user_id', existingUser.id)
      .eq('is_default', true)
      .maybeSingle()

    const isDefault = !existingDefault

    await admin.from('user_groups').upsert(
      {
        user_id:    existingUser.id,
        group_id:   groupId,
        role,
        is_default: isDefault,
      },
      { onConflict: 'user_id,group_id' },
    )

    void admin
      .from('group_invites')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', invite.id)

    let loginLink = `${appUrl}/landing`
    try {
      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
        type:    'magiclink',
        email,
        options: { redirectTo: `${appUrl}/auth/callback?next=/landing` },
      })
      if (linkErr) console.error('[admin/users] generateLink (magiclink) error:', linkErr.message)
      const action = (linkData?.properties as { action_link?: string } | undefined)?.action_link
      if (action) {
        const { data: tokenRow, error: tokenErr } = await admin
          .from('invite_tokens')
          .insert({
            invite_id:   invite.id,
            action_link: action,
            email,
            group_id:    groupId,
            group_name:  groupName,
            role,
          })
          .select('token')
          .single()
        if (tokenErr) {
          console.error('[admin/users] invite_tokens insert error:', tokenErr.message)
          loginLink = action
        } else if (tokenRow) {
          loginLink = `${appUrl}/invite/${(tokenRow as { token: string }).token}`
        }
      }
    } catch (err) {
      console.error('[admin/users] generateLink (magiclink) threw:', err instanceof Error ? err.message : String(err))
    }

    await getResend().emails.send({
      from:    `NavHub <invites@${fromDomain}>`,
      to:      email,
      subject: `You've been added to ${groupName} on NavHub`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px">
          <h2 style="margin:0 0 8px">You've been added to <strong>${groupName}</strong></h2>
          <p style="margin:0 0 16px;color:#555">
            You now have access to <strong>${groupName}</strong> on NavHub with the role
            <strong>${roleLabel}</strong>.
          </p>
          <p style="margin:24px 0">
            <a href="${loginLink}"
               style="display:inline-block;padding:10px 20px;background:#0ea5e9;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
              Open NavHub →
            </a>
          </p>
          <p style="margin:0 0 8px;font-size:12px;color:#777">This link expires in 24 hours.</p>
          <p style="margin-top:24px;font-size:12px;color:#aaa">
            If you weren't expecting this, you can safely ignore this email.
          </p>
        </div>
      `,
    })
  }

  // Audit log
  void admin.from('admin_audit_log').insert({
    actor_id:    session.user.id,
    action:      'invite_user',
    entity_type: 'user',
    entity_id:   invite.id,
    metadata:    { email, group_id: groupId, role, existing: !!existingUser },
  })

  return NextResponse.json(
    { data: { email, invited: true, existing: !!existingUser } },
    { status: 201 },
  )
}
