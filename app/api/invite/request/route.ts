import { NextResponse }      from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { Resend }            from 'resend'

export const runtime = 'nodejs'

// ─── POST /api/invite/request ───────────────────────────────────────────────
// Unauthenticated "request a new invite" endpoint. Called from the invite
// landing page's broken/terminal states (invalid, expired, already-used)
// when the user clicks "Request a new invite".
//
// It looks up a PENDING (not-yet-accepted) group_invites row for the supplied
// email and, if found, re-issues a wrapped invite link the same way the
// authenticated admin resend route does (see
// app/api/groups/[id]/invites/[inviteId]/resend/route.ts).
//
// Anti-enumeration: it ALWAYS returns a neutral 200 success body, whether or
// not the email matched a pending invite, whether or not sending succeeded.
// The caller must never be able to tell whether the email exists.

const ROLE_LABELS: Record<string, string> = {
  group_admin: 'Group Admin',
  manager:     'Manager',
  viewer:      'Viewer',
}

const NEUTRAL = NextResponse.json({ success: true })

export async function POST(request: Request) {
  let email: string | null = null
  try {
    const body = await request.json() as { email?: unknown }
    if (typeof body.email === 'string' && body.email.includes('@')) {
      email = body.email.trim().toLowerCase()
    }
  } catch {
    // Malformed body — stay neutral.
    return NEUTRAL
  }

  if (!email) return NEUTRAL

  // Do the work best-effort; never surface failures to the caller.
  try {
    await reissueInvite(email)
  } catch (err) {
    console.error('[invite/request] reissue threw:', err instanceof Error ? err.message : String(err))
  }

  return NEUTRAL
}

async function reissueInvite(email: string): Promise<void> {
  const admin = createAdminClient()

  // Find a pending (unaccepted) invite for this email. There can be more than
  // one across groups; take the most recent.
  const { data: invite } = await admin
    .from('group_invites')
    .select('id, email, role, group_id, invited_by, accepted_at, created_at')
    .ilike('email', email)
    .is('accepted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!invite) return

  const inv = invite as {
    id:         string
    email:      string
    role:       string
    group_id:   string
    invited_by: string | null
  }

  const { data: group } = await admin
    .from('groups')
    .select('name')
    .eq('id', inv.group_id)
    .single()

  const groupName  = group?.name ?? 'NavHub'
  const roleLabel  = ROLE_LABELS[inv.role] ?? inv.role
  const appUrl     = process.env.NEXT_PUBLIC_APP_URL  ?? 'https://app.navhub.co'
  const fromDomain = process.env.RESEND_FROM_DOMAIN   ?? 'navhub.co'

  // Determine if the invitee already has an auth account — drives whether we
  // mint a magiclink (existing record) or an invite link (brand-new user).
  const { data: userList } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const existingUser = userList?.users.find(u => (u.email ?? '').toLowerCase() === email)

  // Anti-abuse: only re-issue a link to someone who is genuinely still an
  // invitee. That means either:
  //   • no NavHub account yet; or
  //   • an account that has never set a password (user_metadata.password_set
  //     is not true) AND has no group membership in user_groups.
  // An active user — even one who happens to have an old/pending invite row to
  // another group — must get nothing (we still return the neutral success).
  if (existingUser) {
    const passwordSet = (existingUser.user_metadata as { password_set?: unknown } | null)?.password_set === true
    if (passwordSet) return

    const { data: memberships } = await admin
      .from('user_groups')
      .select('user_id')
      .eq('user_id', existingUser.id)
      .limit(1)
    if (memberships && memberships.length > 0) return
  }

  // Everyone who reaches this point is still an invitee (brand-new, or an
  // account that never set a password and has no group membership). Both paths
  // route through /auth/callback and land on /set-password?invite=true so the
  // invitee completes setup.
  //
  // We build a NavHub-owned verification URL carrying the hashed_token, NOT
  // the raw Supabase action_link. The raw action_link points at
  // supabase.co/auth/v1/verify, which returns the session in a URL fragment
  // (#access_token=…) that /auth/callback can't read — the session is lost.
  // /auth/callback instead calls verifyOtp({ type, token_hash }) server-side,
  // writing the session straight to cookies (no fragment, no PKCE verifier).
  const newUserCallbackNext  = encodeURIComponent('/set-password?invite=true')

  let callbackLink: string | null = null
  if (existingUser) {
    // Existing auth record that never finished setup: generateLink({type:
    // 'invite'}) would fail because the user exists, so mint a magiclink but
    // still route to set-password rather than /landing.
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type:    'magiclink',
      email:   inv.email,
      options: { redirectTo: `${appUrl}/auth/callback?next=${newUserCallbackNext}` },
    })
    if (linkErr) console.error('[invite/request] generateLink (magiclink) error:', linkErr.message)
    const hashedToken = (linkData?.properties as { hashed_token?: string } | undefined)?.hashed_token
    callbackLink = hashedToken
      ? `${appUrl}/auth/callback?token_hash=${encodeURIComponent(hashedToken)}&type=magiclink&next=${newUserCallbackNext}`
      : null
  } else {
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type:    'invite',
      email:   inv.email,
      options: { redirectTo: `${appUrl}/auth/callback?next=${newUserCallbackNext}`, data: { group_id: inv.group_id, role: inv.role, invited_by: inv.invited_by } },
    })
    if (linkErr) console.error('[invite/request] generateLink (invite) error:', linkErr.message)
    const hashedToken = (linkData?.properties as { hashed_token?: string } | undefined)?.hashed_token
    callbackLink = hashedToken
      ? `${appUrl}/auth/callback?token_hash=${encodeURIComponent(hashedToken)}&type=invite&next=${newUserCallbackNext}`
      : null
  }

  if (!callbackLink) return

  // Wrap the NavHub callback link in a NavHub /invite/<token> URL via
  // invite_tokens so Microsoft Safe Links / Outlook can't consume the OTP
  // before the user clicks. See migration 061 and
  // app/api/invite/[token]/accept/route.ts.
  let actionLink = callbackLink
  const { data: tokenRow, error: tokenErr } = await admin
    .from('invite_tokens')
    .insert({
      invite_id:   inv.id,
      action_link: callbackLink,
      email:       inv.email,
      group_id:    inv.group_id,
      group_name:  groupName,
      role:        inv.role,
    })
    .select('token')
    .single()
  if (tokenErr) {
    console.error('[invite/request] invite_tokens insert error:', tokenErr.message)
  } else if (tokenRow) {
    actionLink = `${appUrl}/invite/${(tokenRow as { token: string }).token}`
  }

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.error('[invite/request] RESEND_API_KEY not configured')
    return
  }

  const resend = new Resend(apiKey)
  const { error: sendErr } = await resend.emails.send({
    from:    `NavHub <invites@${fromDomain}>`,
    to:      inv.email,
    subject: `You've been invited to join ${groupName} on NavHub`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px">
        <h2 style="margin:0 0 8px">Invitation to <strong>${groupName}</strong></h2>
        <p style="margin:0 0 16px;color:#555">
          You've been invited to join <strong>${groupName}</strong> on NavHub as <strong>${roleLabel}</strong>.
        </p>
        <p style="margin:24px 0">
          <a href="${actionLink}"
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
  if (sendErr) console.error('[invite/request] resend send error:', sendErr.message)
}
