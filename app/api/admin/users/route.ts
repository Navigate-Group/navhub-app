import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

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
// Creates a new user and adds them to a group.
export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const admin = createAdminClient()
  if (!await verifySuperAdmin(session.user.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { email, password, group_id, role } = await req.json() as {
    email: string; password: string; group_id: string; role: string
  }

  if (!email?.trim())    return NextResponse.json({ error: 'Email is required.' }, { status: 400 })
  if (!password?.trim()) return NextResponse.json({ error: 'Password is required.' }, { status: 400 })
  if (!group_id)         return NextResponse.json({ error: 'Group is required.' }, { status: 400 })

  const validRoles = ['group_owner', 'group_admin', 'manager', 'viewer']
  const userRole   = validRoles.includes(role) ? role : 'viewer'

  // Create auth user
  const { data: newUser, error: createErr } = await admin.auth.admin.createUser({
    email:             email.trim(),
    password:          password.trim(),
    email_confirm:     true,
  })
  if (createErr) return NextResponse.json({ error: createErr.message }, { status: 400 })

  // Add to group
  const { error: memberErr } = await admin.from('user_groups').insert({
    user_id:    newUser.user.id,
    group_id,
    role:       userRole,
    is_default: true,
  })
  if (memberErr) return NextResponse.json({ error: memberErr.message }, { status: 500 })

  // Audit log
  void admin.from('admin_audit_log').insert({
    actor_id:    session.user.id,
    action:      'create_user',
    entity_type: 'user',
    entity_id:   newUser.user.id,
    metadata:    { email: email.trim(), group_id, role: userRole },
  })

  return NextResponse.json({ data: { id: newUser.user.id, email: newUser.user.email } }, { status: 201 })
}
