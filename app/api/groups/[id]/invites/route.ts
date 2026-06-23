import { NextResponse }      from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { GroupInvite, PendingPermission, FeatureKey, AccessLevel } from '@/lib/types'
import { FEATURE_KEYS }      from '@/lib/types'
import { canSetPermission }  from '@/lib/permissions'
import { Resend }            from 'resend'

function getResend() {
  return new Resend(process.env.RESEND_API_KEY)
}

// ─── GET/POST /api/groups/[id]/invites ────────────────────────────────────────
// POST sends an email:
//   • New user  → Supabase magic-link invite (→ /accept-invite) + Resend notification
//   • Existing  → Resend notification + immediately adds to group
// Body: { email: string, role: string }

const ADMIN_ROLES     = ['super_admin', 'group_owner', 'group_admin']
const INVITABLE_ROLES = ['group_admin', 'manager', 'staff', 'viewer']

const VALID_ACCESS: AccessLevel[] = ['none', 'view', 'edit']

/** Parse + validate a permissions array off the invite POST body. Returns the
 *  cleaned PendingPermission[] (filtering 'none' entries) or null when the
 *  payload isn't an array. Throws on a malformed entry shape. */
function parsePermissions(raw: unknown): PendingPermission[] {
  if (!Array.isArray(raw)) return []
  const out: PendingPermission[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    const feature = p.feature as FeatureKey
    const access  = p.access  as AccessLevel
    const companyId = p.company_id === null || p.company_id === undefined
      ? null
      : String(p.company_id)
    if (!FEATURE_KEYS.includes(feature)) continue
    if (!VALID_ACCESS.includes(access)) continue
    // Don't persist explicit 'none' — absence already means no access.
    if (access === 'none') continue
    out.push({ feature, company_id: companyId, access })
  }
  return out
}

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (params.id !== activeGroupId) return NextResponse.json({ error: 'Group not found' }, { status: 404 })

  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', params.id)
    .single()

  if (!membership || !ADMIN_ROLES.includes(membership.role)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const admin = createAdminClient()
  const { data: invites, error } = await admin
    .from('group_invites')
    .select('*')
    .eq('group_id', params.id)
    .is('accepted_at', null)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Defence-in-depth: also filter out invites whose email is already a
  // member of this group. Catches stale rows where accepted_at was never
  // written (e.g. early invites that bypassed the join route).
  const { data: memberships } = await admin
    .from('user_groups')
    .select('user_id')
    .eq('group_id', params.id)
  const memberIds = ((memberships ?? []) as Array<{ user_id: string }>).map(m => m.user_id)
  const memberEmails = new Set<string>()
  if (memberIds.length > 0) {
    const { data: userList } = await admin.auth.admin.listUsers({ perPage: 1000 })
    for (const u of userList?.users ?? []) {
      if (memberIds.includes(u.id) && u.email) memberEmails.add(u.email.toLowerCase())
    }
  }

  const filtered = ((invites ?? []) as GroupInvite[])
    .filter(i => !memberEmails.has(i.email.toLowerCase()))

  return NextResponse.json({ data: filtered })
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (params.id !== activeGroupId) return NextResponse.json({ error: 'Group not found' }, { status: 404 })

  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', params.id)
    .single()

  if (!membership || !ADMIN_ROLES.includes(membership.role)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  let body: Record<string, unknown>
  try { body = await request.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const email     = typeof body.email     === 'string' ? body.email.trim().toLowerCase() : ''
  const role      = typeof body.role      === 'string' ? body.role : ''
  const fullName  = typeof body.full_name === 'string' ? body.full_name.trim() : ''

  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'Valid email is required' }, { status: 400 })
  }
  if (!INVITABLE_ROLES.includes(role)) {
    return NextResponse.json(
      { error: `role must be one of: ${INVITABLE_ROLES.join(', ')}` },
      { status: 422 }
    )
  }

  // Optional pre-set permissions to stage with the invite (migration 068).
  // Admin roles bypass the matrix, so permissions only apply to
  // manager / staff / viewer.
  const presetPermissions = parsePermissions(body.permissions)
  // Enforce the staff 'Admin only' rule at invite time too: a group_admin
  // cannot stage financials/marketing access above 'none' for a staff member.
  for (const p of presetPermissions) {
    if (!canSetPermission(membership.role, role, p.feature, p.access)) {
      return NextResponse.json(
        { error: `Only a group owner or super admin can grant ${p.feature} access to a staff member.` },
        { status: 403 },
      )
    }
  }

  const admin = createAdminClient()

  // Refuse if there's already a pending (unaccepted) invite for this email
  // and group — avoids spamming the invitee with duplicate magic-link emails.
  const { data: pendingInvite } = await admin
    .from('group_invites')
    .select('id')
    .eq('group_id', params.id)
    .eq('email',    email)
    .is('accepted_at', null)
    .maybeSingle()
  if (pendingInvite) {
    return NextResponse.json(
      { error: 'This email already has a pending invite' },
      { status: 409 }
    )
  }

  // If the email belongs to an existing Supabase user, refuse if they're
  // already a member of this group.
  const { data: existingUserList } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const preExistingUser = existingUserList?.users.find(u => u.email === email)
  if (preExistingUser) {
    const { data: existingMember } = await admin
      .from('user_groups')
      .select('user_id')
      .eq('group_id', params.id)
      .eq('user_id', preExistingUser.id)
      .maybeSingle()
    if (existingMember) {
      return NextResponse.json(
        { error: 'This user is already a member of this group' },
        { status: 409 }
      )
    }
  }

  // Fetch the group name for email copy
  const { data: group } = await admin
    .from('groups')
    .select('name')
    .eq('id', params.id)
    .single()

  const groupName  = group?.name ?? 'a NavHub group'
  const roleLabel  = role.replace(/_/g, ' ')
  const appUrl     = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.navhub.co'
  const fromDomain = process.env.RESEND_FROM_DOMAIN   ?? 'navhub.co'

  // Record the invite in DB
  const { data: invite, error: inviteErr } = await admin
    .from('group_invites')
    .upsert(
      {
        group_id:            params.id,
        email,
        role,
        full_name:           fullName || null,
        invited_by:          session.user.id,
        pending_permissions: presetPermissions.length > 0 ? presetPermissions : null,
      },
      { onConflict: 'group_id,email', ignoreDuplicates: false }
    )
    .select()
    .single()

  if (inviteErr) {
    return NextResponse.json({ error: inviteErr.message }, { status: 500 })
  }

  // ── Does this email already have a Supabase account? ───────────────────────
  const { data: userList } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const existingUser = userList?.users.find(u => u.email === email)

  if (!existingUser) {
    // ── NEW user — generate signup link directly so the invite email itself
    //    contains a working "Accept invitation" button (no second email).
    // Invite link bounces the user through /auth/callback (the PKCE
    // handler — see app/auth/callback/route.ts). That route exchanges the
    // code for a session AND claims every pending group_invites row keyed
    // to the user's email.
    //
    // For NEW users we send them to /set-password?invite=true after the
    // callback so they can set their password before landing in the app
    // (Supabase invite accounts have no password by default). The `next`
    // query param's value is URL-encoded so its own `?invite=true` query
    // string survives our own callback parsing.
    const redirectTo = `${appUrl}/auth/callback?next=${encodeURIComponent('/set-password?invite=true')}`

    let signupLink = `${appUrl}/login`
    try {
      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
        type:  'invite',
        email,
        options: { redirectTo, data: { group_id: params.id, role, invited_by: session.user.id } },
      })
      if (linkErr) {
        console.error('[invite] generateLink (invite) error:', linkErr.message)
      }
      // ── Capture the hashed_token, NOT the raw Supabase action_link ─────────
      // The raw action_link points at supabase.co/auth/v1/verify, which returns
      // the session in a URL fragment (#access_token=…) that our /auth/callback
      // route can't read — the session is lost. Instead we build a NavHub-owned
      // verification URL that carries the hashed_token; /auth/callback calls
      // supabase.auth.verifyOtp({type:'invite', token_hash}) server-side,
      // writing the session straight to cookies (no fragment, no PKCE verifier).
      const hashedToken = (linkData?.properties as { hashed_token?: string } | undefined)?.hashed_token
      const action = hashedToken
        ? `${appUrl}/auth/callback?token_hash=${encodeURIComponent(hashedToken)}&type=invite&next=${encodeURIComponent('/set-password?invite=true')}`
        : undefined
      if (action) {
        // ── Outlook / Microsoft Safe Links work-around ─────────────────────
        // Email security scanners follow every link to check for malware,
        // which consumes Supabase's one-time OTP before the user clicks.
        // Store the action_link server-side and email a NavHub URL instead;
        // the scanner gets a static page, the user clicks "Accept" which
        // POSTs to /api/invite/[token]/accept and redirects to the real link.
        const { data: tokenRow, error: tokenErr } = await admin
          .from('invite_tokens')
          .insert({
            invite_id:   invite.id,
            action_link: action,
            email,
            group_id:    params.id,
            group_name:  groupName,
            role,
            full_name:   fullName || null,
          })
          .select('token')
          .single()
        if (tokenErr) {
          console.error('[invite] invite_tokens insert error:', tokenErr.message)
          // Fall back to the raw action_link if we can't persist (better
          // than no link at all, but the email scanner will likely eat it).
          signupLink = action
        } else if (tokenRow) {
          signupLink = `${appUrl}/invite/${(tokenRow as { token: string }).token}`
        }
      }
    } catch (err) {
      console.error('[invite] generateLink (invite) threw:', err instanceof Error ? err.message : String(err))
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
    // ── EXISTING user — add immediately + send notification ───────────────────

    // Determine is_default: make this group the default only if the user has no
    // existing default group. This handles the case where a user is added to a
    // second (or later) group — their original default must not be overwritten.
    const { data: existingDefault } = await admin
      .from('user_groups')
      .select('id')
      .eq('user_id', existingUser.id)
      .eq('is_default', true)
      .single()

    const isDefault = !existingDefault

    await admin.from('user_groups').upsert(
      {
        user_id:    existingUser.id,
        group_id:   params.id,
        role,
        is_default: isDefault,
      },
      { onConflict: 'user_id,group_id' }
    )

    // Existing user is added immediately — apply any pre-set permissions
    // straight to user_permissions now (no token-accept step for them).
    if (presetPermissions.length > 0) {
      await admin
        .from('user_permissions')
        .delete()
        .eq('user_id', existingUser.id)
        .eq('group_id', params.id)

      const rows = presetPermissions.map(p => ({
        user_id:    existingUser.id,
        group_id:   params.id,
        feature:    p.feature,
        company_id: p.company_id,
        access:     p.access,
        updated_by: session.user.id,
        updated_at: new Date().toISOString(),
      }))
      const { error: permErr } = await admin.from('user_permissions').insert(rows)
      if (permErr) console.error('[invite] user_permissions insert error:', permErr.message)
    }

    // Mark invite accepted
    void admin
      .from('group_invites')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', invite.id)

    // Existing user — generate a magic link so they can sign in straight from
    // the email; fall back to the plain login page if the call fails. The
    // redirectTo points at /auth/callback (PKCE code-exchange) which also
    // claims any pending invites server-side before redirecting to /landing.
    let loginLink = `${appUrl}/landing`
    try {
      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
        type:    'magiclink',
        email,
        options: { redirectTo: `${appUrl}/auth/callback?next=/landing` },
      })
      if (linkErr) console.error('[invite] generateLink (magiclink) error:', linkErr.message)
      const action = (linkData?.properties as { action_link?: string } | undefined)?.action_link
      if (action) {
        // Same Outlook scanner workaround — see new-user branch for context.
        const { data: tokenRow, error: tokenErr } = await admin
          .from('invite_tokens')
          .insert({
            invite_id:   invite.id,
            action_link: action,
            email,
            group_id:    params.id,
            group_name:  groupName,
            role,
            full_name:   fullName || null,
          })
          .select('token')
          .single()
        if (tokenErr) {
          console.error('[invite] invite_tokens insert error:', tokenErr.message)
          loginLink = action
        } else if (tokenRow) {
          loginLink = `${appUrl}/invite/${(tokenRow as { token: string }).token}`
        }
      }
    } catch (err) {
      console.error('[invite] generateLink (magiclink) threw:', err instanceof Error ? err.message : String(err))
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

  return NextResponse.json({ data: invite as GroupInvite }, { status: 201 })
}
