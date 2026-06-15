import { NextResponse }      from 'next/server'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

// ─── POST /api/auth/claim-invites ───────────────────────────────────────────
// Called from the accept-invite page (after a magic link has authenticated
// the user) and from /no-group as a recovery action. Finds every pending
// group_invites row matching the caller's email and:
//   • Inserts a user_groups membership using the role recorded on the invite
//   • Sets is_default=true on the FIRST membership added (only if the user
//     has no existing default group)
//   • If the invite carries a full_name, copies it into the user's
//     user_metadata so the dashboard greeting is personalised
//   • Marks each invite accepted_at = now()
//
// This is the fallback path: the URL-based /api/groups/[id]/join still works
// and is preferred when a specific group_id is on the URL, but if the param
// gets dropped or stale the user can still land in their group(s).
//
// Response shape:
//   { data: { claimed: number, group_ids: string[], active_group_id: string | null } }
//
// Sets active_group_id cookie when claiming the first group.

export async function POST() {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const email = session.user.email?.toLowerCase()
  if (!email) {
    return NextResponse.json({ error: 'No email on session' }, { status: 400 })
  }

  const admin = createAdminClient()

  // Pending invites for this email across ALL groups.
  const { data: invites } = await admin
    .from('group_invites')
    .select('id, group_id, role, full_name, pending_permissions')
    .eq('email', email)
    .is('accepted_at', null)

  const pending = (invites ?? []) as Array<{
    id:                  string
    group_id:            string
    role:                string
    full_name:           string | null
    pending_permissions: Array<{ feature: string; company_id: string | null; access: string }> | null
  }>

  if (pending.length === 0) {
    return NextResponse.json({ data: { claimed: 0, group_ids: [], active_group_id: null } })
  }

  // Does the user already have a default group? Only the FIRST claimed
  // invite is allowed to set is_default=true — and only when no existing
  // default exists. Avoids overwriting a returning user's preferred group.
  const { data: existingDefault } = await admin
    .from('user_groups')
    .select('group_id')
    .eq('user_id', session.user.id)
    .eq('is_default', true)
    .maybeSingle()

  let firstClaimedGroupId: string | null = null
  let setDefault = !existingDefault
  const claimedIds: string[] = []
  let nameToCopy: string | null = null

  for (const invite of pending) {
    const { error: upsertErr } = await admin
      .from('user_groups')
      .upsert(
        {
          user_id:    session.user.id,
          group_id:   invite.group_id,
          role:       invite.role,
          is_default: setDefault,
        },
        { onConflict: 'user_id,group_id' },
      )
    if (upsertErr) {
      console.error('[claim-invites] upsert failed:', upsertErr.message)
      continue
    }

    claimedIds.push(invite.group_id)
    if (!firstClaimedGroupId) firstClaimedGroupId = invite.group_id
    if (invite.full_name && !nameToCopy) nameToCopy = invite.full_name
    setDefault = false   // only the first claim flips the default flag

    // Seed user_permissions from the invite's pre-set permissions (migration
    // 068). Only meaningful for non-admin roles — admins bypass the matrix.
    // The values were validated against the staff 'Admin only' rule when the
    // invite was created, so we apply them as-is here.
    const presetPerms = Array.isArray(invite.pending_permissions) ? invite.pending_permissions : []
    if (presetPerms.length > 0) {
      await admin
        .from('user_permissions')
        .delete()
        .eq('user_id', session.user.id)
        .eq('group_id', invite.group_id)

      const permRows = presetPerms
        .filter(p => p.access && p.access !== 'none')
        .map(p => ({
          user_id:    session.user.id,
          group_id:   invite.group_id,
          feature:    p.feature,
          company_id: p.company_id ?? null,
          access:     p.access,
          updated_by: session.user.id,
          updated_at: new Date().toISOString(),
        }))
      if (permRows.length > 0) {
        const { error: permErr } = await admin.from('user_permissions').insert(permRows)
        if (permErr) console.error('[claim-invites] user_permissions insert failed:', permErr.message)
      }
    }

    // Mark accepted (fire-and-forget — we already have the membership).
    void admin
      .from('group_invites')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', invite.id)
  }

  // Copy invite full_name into the user's metadata if we don't already have
  // a non-empty value. Existing names are not overwritten.
  if (nameToCopy) {
    const existingName = (session.user.user_metadata as { full_name?: string } | null)?.full_name
    if (!existingName || !existingName.trim()) {
      try {
        await admin.auth.admin.updateUserById(session.user.id, {
          user_metadata: { ...(session.user.user_metadata ?? {}), full_name: nameToCopy },
        })
      } catch (err) {
        console.error('[claim-invites] failed to set full_name:', err)
      }
    }
  }

  const response = NextResponse.json({
    data: {
      claimed:         claimedIds.length,
      group_ids:       claimedIds,
      active_group_id: firstClaimedGroupId,
    },
  })

  if (firstClaimedGroupId) {
    response.cookies.set('active_group_id', firstClaimedGroupId, {
      httpOnly: false,
      path:     '/',
      maxAge:   60 * 60 * 24 * 365,
    })
  }

  return response
}
