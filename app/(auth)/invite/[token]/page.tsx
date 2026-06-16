import { createAdminClient } from '@/lib/supabase/admin'
import InviteAcceptClient    from './InviteAcceptClient'

// Server component — fetches token metadata via the admin client. The
// action_link is NEVER passed to the client; only display fields are.
// The accept handshake happens via POST /api/invite/[token]/accept.
//
// On a failed token lookup we DO NOT call notFound(). Tokens can outlive
// their group_invites row (an admin cancels/resends; the invite row is
// deleted but the email link still points here) and unknown tokens happen
// too. Both cases render a styled "link no longer valid" state inside
// InviteLayout instead of a bare 404.

async function hasExistingAccountForEmail(
  admin: ReturnType<typeof createAdminClient>,
  email: string | null,
): Promise<boolean> {
  if (!email) return false
  try {
    const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
    const target = email.toLowerCase()
    return !!data?.users.some(u => (u.email ?? '').toLowerCase() === target)
  } catch {
    return false
  }
}

export default async function InvitePage({
  params,
}: {
  params: { token: string }
}) {
  const admin = createAdminClient()

  const { data: invite, error } = await admin
    .from('invite_tokens')
    .select('email, group_name, role, full_name, used_at, expires_at')
    .eq('token', params.token)
    .single()

  if (error || !invite) {
    // Unknown token (or its row is otherwise unreadable). We have no email to
    // check against, so default to the no-account path.
    return (
      <InviteAcceptClient
        token={params.token}
        email=""
        groupName=""
        role=""
        fullName={null}
        isUsed={false}
        isExpired={false}
        isInvalid={true}
        hasExistingAccount={false}
      />
    )
  }

  const inv = invite as {
    email:      string
    group_name: string
    role:       string
    full_name:  string | null
    used_at:    string | null
    expires_at: string
  }

  const hasExistingAccount = await hasExistingAccountForEmail(admin, inv.email)

  return (
    <InviteAcceptClient
      token={params.token}
      email={inv.email}
      groupName={inv.group_name}
      role={inv.role}
      fullName={inv.full_name}
      isUsed={!!inv.used_at}
      isExpired={new Date(inv.expires_at) < new Date()}
      isInvalid={false}
      hasExistingAccount={hasExistingAccount}
    />
  )
}
