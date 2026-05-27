import { NextResponse }     from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { Resend }            from 'resend'

/**
 * POST /api/groups/[id]/invites/[inviteId]/resend
 * Re-issues a magic-link / invite link for a pending invite and emails it
 * via Resend. Admin only. Returns { success: true }.
 */

const ADMIN_ROLES   = ['super_admin', 'group_owner', 'group_admin']
const ROLE_LABELS: Record<string, string> = {
  group_admin: 'Group Admin',
  manager:     'Manager',
  viewer:      'Viewer',
}

export async function POST(
  _request: Request,
  { params }: { params: { id: string; inviteId: string } }
) {
  const supabase    = createClient()
  const cookieStore = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (params.id !== activeGroupId) {
    return NextResponse.json({ error: 'Group not found' }, { status: 404 })
  }

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

  const { data: invite } = await admin
    .from('group_invites')
    .select('id, email, role, group_id, accepted_at')
    .eq('id', params.inviteId)
    .eq('group_id', params.id)
    .maybeSingle()

  if (!invite) {
    return NextResponse.json({ error: 'Invite not found' }, { status: 404 })
  }
  if (invite.accepted_at) {
    return NextResponse.json({ error: 'Invite already accepted' }, { status: 422 })
  }

  const { data: group } = await admin
    .from('groups')
    .select('name')
    .eq('id', params.id)
    .single()

  const groupName  = group?.name ?? 'NavHub'
  const roleLabel  = ROLE_LABELS[invite.role as string] ?? (invite.role as string)
  const appUrl     = process.env.NEXT_PUBLIC_APP_URL  ?? 'https://app.navhub.co'
  const fromDomain = process.env.RESEND_FROM_DOMAIN   ?? 'navhub.co'

  // Determine if the invitee already has an auth account
  const { data: userList } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const existingUser = userList?.users.find(u => u.email === invite.email)

  let actionLink = `${appUrl}/login`
  let isExisting = false
  try {
    // Both paths (magiclink for existing user, invite for new user) route
    // through /auth/callback — see app/auth/callback/route.ts. That handler
    // exchanges the PKCE code AND claims every pending group_invites row
    // keyed to the user's email.
    //
    // The raw action_link is wrapped in a NavHub /invite/<token> URL via
    // the invite_tokens table — Microsoft Safe Links / Outlook follow every
    // link in an email and would otherwise consume the OTP before the user
    // clicks. See app/api/invite/[token]/accept/route.ts.
    // Existing users go straight to /landing — they already have a
    // password. New users (invite branch) land on /set-password?invite=true
    // first so they can set one before entering the app.
    const existingCallbackUrl = `${appUrl}/auth/callback?next=/landing`
    const newUserCallbackUrl  = `${appUrl}/auth/callback?next=${encodeURIComponent('/set-password?invite=true')}`
    let rawActionLink: string | null = null
    if (existingUser) {
      isExisting = true
      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
        type:    'magiclink',
        email:   invite.email as string,
        options: { redirectTo: existingCallbackUrl },
      })
      if (linkErr) console.error('[resend] generateLink (magiclink) error:', linkErr.message)
      rawActionLink = (linkData?.properties as { action_link?: string } | undefined)?.action_link ?? null
    } else {
      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
        type:    'invite',
        email:   invite.email as string,
        options: { redirectTo: newUserCallbackUrl, data: { group_id: params.id, role: invite.role, invited_by: session.user.id } },
      })
      if (linkErr) console.error('[resend] generateLink (invite) error:', linkErr.message)
      rawActionLink = (linkData?.properties as { action_link?: string } | undefined)?.action_link ?? null
    }

    if (rawActionLink) {
      const { data: tokenRow, error: tokenErr } = await admin
        .from('invite_tokens')
        .insert({
          invite_id:   params.inviteId,
          action_link: rawActionLink,
          email:       invite.email as string,
          group_id:    params.id,
          group_name:  groupName,
          role:        invite.role as string,
        })
        .select('token')
        .single()
      if (tokenErr) {
        console.error('[resend] invite_tokens insert error:', tokenErr.message)
        actionLink = rawActionLink
      } else if (tokenRow) {
        actionLink = `${appUrl}/invite/${(tokenRow as { token: string }).token}`
      }
    }
  } catch (err) {
    console.error('[resend] generateLink threw:', err instanceof Error ? err.message : String(err))
  }

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'RESEND_API_KEY not configured' }, { status: 500 })
  }

  const resend = new Resend(apiKey)
  const { error: sendErr } = await resend.emails.send({
    from:    `NavHub <invites@${fromDomain}>`,
    to:      invite.email as string,
    subject: `Reminder: You've been invited to join ${groupName} on NavHub`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px">
        <h2 style="margin:0 0 8px">Reminder: invitation to <strong>${groupName}</strong></h2>
        <p style="margin:0 0 16px;color:#555">
          You've been invited to join <strong>${groupName}</strong> on NavHub as <strong>${roleLabel}</strong>.
        </p>
        <p style="margin:24px 0">
          <a href="${actionLink}"
             style="display:inline-block;padding:10px 20px;background:#0ea5e9;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
            ${isExisting ? 'Sign in to NavHub →' : 'Accept invitation &amp; set up your account →'}
          </a>
        </p>
        <p style="margin:0 0 8px;font-size:12px;color:#777">This link expires in 24 hours.</p>
        <p style="margin-top:24px;font-size:12px;color:#aaa">
          If you weren't expecting this, you can safely ignore this email.
        </p>
      </div>
    `,
  })
  if (sendErr) {
    return NextResponse.json({ error: sendErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
