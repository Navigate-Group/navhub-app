import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateSlug } from '@/lib/utils'

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

  // Find or create owner user
  const { data: { users } } = await admin.auth.admin.listUsers({ perPage: 1000 })
  let ownerId: string

  const existing = users.find((u: { email?: string }) => u.email?.toLowerCase() === owner_email.toLowerCase().trim())
  if (existing) {
    ownerId = existing.id
  } else {
    // Create user with a temporary random password
    const tempPassword = Math.random().toString(36).slice(-16) + Math.random().toString(36).slice(-16)
    const { data: newUser, error: createErr } = await admin.auth.admin.createUser({
      email:         owner_email.trim(),
      password:      tempPassword,
      email_confirm: true,
    })
    if (createErr) return NextResponse.json({ error: `Failed to create user: ${createErr.message}` }, { status: 400 })
    ownerId = newUser.user.id
  }

  // Create slug
  const slug = generateSlug(name.trim())

  // Create the group
  const { data: group, error: groupErr } = await admin.from('groups').insert({
    name:              name.trim(),
    slug,
    subscription_tier: tier,
    token_limit_mtd:   limit,
    owner_id:          ownerId,
    palette_id:        'ocean',
    is_active:         true,
  }).select('id, name').single()

  if (groupErr) return NextResponse.json({ error: groupErr.message }, { status: 500 })

  // Add owner as group_owner of the new group (migration 062).
  // Also stamp owner_user_id on the groups row for ownership lookups.
  void admin.from('groups').update({ owner_user_id: ownerId }).eq('id', group.id)
  const { error: memberErr } = await admin.from('user_groups').insert({
    user_id:    ownerId,
    group_id:   group.id,
    role:       'group_owner',
    is_default: true,
  })
  if (memberErr) return NextResponse.json({ error: memberErr.message }, { status: 500 })

  // Audit log
  void admin.from('admin_audit_log').insert({
    actor_id:    session.user.id,
    action:      'create_group',
    entity_type: 'group',
    entity_id:   group.id,
    metadata:    { name: name.trim(), owner_email: owner_email.trim(), tier },
  })

  return NextResponse.json({ data: group }, { status: 201 })
}
