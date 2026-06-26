import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateSlug } from '@/lib/utils'
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

// ─── GET /api/admin/groups ────────────────────────────────────────────────────
export async function GET() {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const admin = createAdminClient()
  if (!await verifySuperAdmin(session.user.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data: groups } = await admin
    .from('groups')
    .select('id, name, slug, palette_id, created_at, subscription_tier, token_usage_mtd, token_limit_mtd, is_active')
    .order('created_at', { ascending: false })

  if (!groups) return NextResponse.json({ data: [] })

  const groupIds = groups.map((g: { id: string }) => g.id)

  const [{ data: companies }, { data: members }, { data: runs }] = await Promise.all([
    admin.from('companies').select('group_id').eq('is_active', true).in('group_id', groupIds),
    admin.from('user_groups').select('group_id').in('group_id', groupIds),
    admin.from('agent_runs').select('group_id, created_at').in('group_id', groupIds).order('created_at', { ascending: false }).limit(2000),
  ])

  const compByGroup:    Record<string, number> = {}
  const memberByGroup:  Record<string, number> = {}
  const lastRunByGroup: Record<string, string> = {}

  for (const c of (companies ?? []) as Array<{ group_id: string }>) {
    compByGroup[c.group_id] = (compByGroup[c.group_id] ?? 0) + 1
  }
  for (const m of (members ?? []) as Array<{ group_id: string }>) {
    memberByGroup[m.group_id] = (memberByGroup[m.group_id] ?? 0) + 1
  }
  for (const r of (runs ?? []) as Array<{ group_id: string; created_at: string }>) {
    if (!lastRunByGroup[r.group_id]) lastRunByGroup[r.group_id] = r.created_at
  }

  type GroupRaw = {
    id: string; name: string; slug: string | null; palette_id: string | null; created_at: string
    subscription_tier: string; token_usage_mtd: number; token_limit_mtd: number; is_active: boolean
  }

  const data = (groups as GroupRaw[]).map(g => ({
    ...g,
    company_count: compByGroup[g.id]    ?? 0,
    user_count:    memberByGroup[g.id]  ?? 0,
    last_run_at:   lastRunByGroup[g.id] ?? null,
  }))

  return NextResponse.json({ data })
}

// ─── POST /api/admin/groups ───────────────────────────────────────────────────
// Creates a new group and assigns an owner.
export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const admin = createAdminClient()
  if (!await verifySuperAdmin(session.user.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { name, owner_email, subscription_tier, token_limit_mtd } = await req.json() as {
    name: string; owner_email: string; subscription_tier?: string; token_limit_mtd?: number
  }

  if (!name?.trim())        return NextResponse.json({ error: 'Name is required.' }, { status: 400 })
  if (!owner_email?.trim()) return NextResponse.json({ error: 'Owner email is required.' }, { status: 400 })

  const TIER_LIMITS: Record<string, number> = { starter: 1_000_000, pro: 5_000_000, enterprise: 20_000_000 }
  const tier  = ['starter', 'pro', 'enterprise'].includes(subscription_tier ?? '') ? subscription_tier! : 'starter'
  const limit = token_limit_mtd ?? TIER_LIMITS[tier]

  const email      = owner_email.toLowerCase().trim()
  const appUrl     = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.navhub.co'
  const fromDomain = process.env.RESEND_FROM_DOMAIN  ?? 'navhub.co'
  const ownerRole  = 'group_owner'

  // Does this email already belong to a Supabase user? New owners are NEVER
  // created with a plaintext password — they're invited via email and set
  // their own password (mirrors app/api/groups/[id]/invites/route.ts).
  const { data: { users } } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const existing = users.find((u: { email?: string }) => (u.email ?? '').toLowerCase() === email)

  // Create slug
  const slug = generateSlug(name.trim())

  // Create the group. owner_id / owner_user_id are stamped immediately for an
  // existing owner; for a new (invited) owner they're filled when the invite
  // is accepted and the user_groups membership is claimed by /auth/callback.
  const { data: group, error: groupErr } = await admin.from('groups').insert({
    name:              name.trim(),
    slug,
    subscription_tier: tier,
    token_limit_mtd:   limit,
    owner_id:          existing?.id ?? null,
    owner_user_id:     existing?.id ?? null,
    palette_id:        'ocean',
    is_active:         true,
  }).select('id, name').single()

  if (groupErr) return NextResponse.json({ error: groupErr.message }, { status: 500 })

  const groupName = group.name ?? name.trim()

  // Record the invite so /auth/callback claims it (new owner) — for an existing
  // owner we mark it accepted right away since they're added immediately.
  const { data: invite, error: inviteErr } = await admin
    .from('group_invites')
    .upsert(
      {
        group_id:    group.id,
        email,
        role:        ownerRole,
        invited_by:  session.user.id,
        accepted_at: existing ? new Date().toISOString() : null,
      },
      { onConflict: 'group_id,email', ignoreDuplicates: false },
    )
    .select()
    .single()
  if (inviteErr) return NextResponse.json({ error: inviteErr.message }, { status: 500 })

  if (existing) {
    // ── EXISTING user — add as group owner immediately + magic-link notice. ──
    const { error: memberErr } = await admin.from('user_groups').upsert(
      {
        user_id:    existing.id,
        group_id:   group.id,
        role:       ownerRole,
        is_default: true,
      },
      { onConflict: 'user_id,group_id' },
    )
    if (memberErr) return NextResponse.json({ error: memberErr.message }, { status: 500 })

    let loginLink = `${appUrl}/landing`
    try {
      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
        type:    'magiclink',
        email,
        options: { redirectTo: `${appUrl}/auth/callback?next=/landing` },
      })
      if (linkErr) console.error('[admin/groups] generateLink (magiclink) error:', linkErr.message)
      const action = (linkData?.properties as { action_link?: string } | undefined)?.action_link
      if (action) {
        const { data: tokenRow, error: tokenErr } = await admin
          .from('invite_tokens')
          .insert({
            invite_id:   invite.id,
            action_link: action,
            email,
            group_id:    group.id,
            group_name:  groupName,
            role:        ownerRole,
          })
          .select('token')
          .single()
        if (tokenErr) {
          console.error('[admin/groups] invite_tokens insert error:', tokenErr.message)
          loginLink = action
        } else if (tokenRow) {
          loginLink = `${appUrl}/invite/${(tokenRow as { token: string }).token}`
        }
      }
    } catch (err) {
      console.error('[admin/groups] generateLink (magiclink) threw:', err instanceof Error ? err.message : String(err))
    }

    await getResend().emails.send({
      from:    `NavHub <invites@${fromDomain}>`,
      to:      email,
      subject: `You're now the owner of ${groupName} on NavHub`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px">
          <h2 style="margin:0 0 8px">You now own <strong>${groupName}</strong></h2>
          <p style="margin:0 0 16px;color:#555">
            You've been made the <strong>group owner</strong> of <strong>${groupName}</strong> on NavHub.
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
  } else {
    // ── NEW owner — invite link (no password). Mirror the invites route. ─────
    const redirectTo = `${appUrl}/auth/callback?next=${encodeURIComponent('/set-password?invite=true')}`

    let signupLink = `${appUrl}/login`
    try {
      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
        type:    'invite',
        email,
        options: { redirectTo, data: { group_id: group.id, role: ownerRole, invited_by: session.user.id } },
      })
      if (linkErr) console.error('[admin/groups] generateLink (invite) error:', linkErr.message)

      const hashedToken = (linkData?.properties as { hashed_token?: string } | undefined)?.hashed_token
      const action = hashedToken
        ? `${appUrl}/auth/callback?token_hash=${encodeURIComponent(hashedToken)}&type=invite&next=${encodeURIComponent('/set-password?invite=true')}`
        : undefined
      if (action) {
        const { data: tokenRow, error: tokenErr } = await admin
          .from('invite_tokens')
          .insert({
            invite_id:   invite.id,
            action_link: action,
            email,
            group_id:    group.id,
            group_name:  groupName,
            role:        ownerRole,
          })
          .select('token')
          .single()
        if (tokenErr) {
          console.error('[admin/groups] invite_tokens insert error:', tokenErr.message)
          signupLink = action
        } else if (tokenRow) {
          signupLink = `${appUrl}/invite/${(tokenRow as { token: string }).token}`
        }
      }
    } catch (err) {
      console.error('[admin/groups] generateLink (invite) threw:', err instanceof Error ? err.message : String(err))
    }

    await getResend().emails.send({
      from:    `NavHub <invites@${fromDomain}>`,
      to:      email,
      subject: `You've been invited to own ${groupName} on NavHub`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px">
          <h2 style="margin:0 0 8px">You've been invited to own <strong>${groupName}</strong></h2>
          <p style="margin:0 0 16px;color:#555">
            You've been invited to set up <strong>${groupName}</strong> on NavHub as the
            <strong>group owner</strong>.
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
  }

  // Audit log
  void admin.from('admin_audit_log').insert({
    actor_id:    session.user.id,
    action:      'create_group',
    entity_type: 'group',
    entity_id:   group.id,
    metadata:    { name: name.trim(), owner_email: email, tier, owner_existing: !!existing },
  })

  return NextResponse.json({ data: group }, { status: 201 })
}
