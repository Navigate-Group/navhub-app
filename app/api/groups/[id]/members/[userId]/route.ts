import { NextResponse }                      from 'next/server'
import { cookies }                           from 'next/headers'
import { createClient }                      from '@/lib/supabase/server'
import { createAdminClient }                 from '@/lib/supabase/admin'
import { canManageRole, canAssignRole }      from '@/lib/permissions'

// ─── PATCH /api/groups/[id]/members/[userId] ─────────────────────────────────
// Updates a member's role.
// Body: { role: string }
// Cannot demote the last super_admin. Enforces the role hierarchy server-side:
//   • super_admin: can manage anyone except other super_admins
//   • group_owner: can manage group_admin and below; cannot mint another owner
//   • group_admin: can manage manager / viewer only
//
// ─── DELETE /api/groups/[id]/members/[userId] ────────────────────────────────
// Removes a member from the group. Same hierarchy + last-super-admin guard.

const ADMIN_ROLES   = ['super_admin', 'group_owner', 'group_admin']
const ALLOWED_ROLES = ['super_admin', 'group_owner', 'group_admin', 'manager', 'viewer']

type Params = { params: { id: string; userId: string } }

async function verifyAdminAccess(groupId: string, callerUserId: string, activeGroupId: string | undefined) {
  if (groupId !== activeGroupId) return { status: 'not_found' as const }
  const supabase = createClient()
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', callerUserId)
    .eq('group_id', groupId)
    .single()
  if (!membership || !ADMIN_ROLES.includes(membership.role)) return { status: 'forbidden' as const }
  return { status: 'ok' as const, role: membership.role as string }
}

// Look up the target member's current role so we can guard against group_admins
// modifying super_admins.
async function getTargetRole(groupId: string, userId: string): Promise<string | null> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('user_groups')
    .select('role')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle()
  return (data as { role?: string } | null)?.role ?? null
}

async function checkLastSuperAdmin(groupId: string, targetUserId: string): Promise<boolean> {
  const admin = createAdminClient()
  const { data: superAdmins } = await admin
    .from('user_groups')
    .select('user_id')
    .eq('group_id', groupId)
    .eq('role', 'super_admin')
  const admins = (superAdmins ?? []) as { user_id: string }[]
  return admins.length === 1 && admins[0].user_id === targetUserId
}

export async function PATCH(request: Request, { params }: Params) {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const access = await verifyAdminAccess(params.id, session.user.id, activeGroupId)
  if (access.status === 'not_found') return NextResponse.json({ error: 'Group not found' },     { status: 404 })
  if (access.status === 'forbidden') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  const callerRole = access.role

  let body: Record<string, unknown>
  try { body = await request.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const newRole = typeof body.role === 'string' ? body.role : null
  if (!newRole || !ALLOWED_ROLES.includes(newRole)) {
    return NextResponse.json({ error: `role must be one of: ${ALLOWED_ROLES.join(', ')}` }, { status: 422 })
  }

  // Role-hierarchy enforcement (migration 062). Three guards:
  //   1. Caller must be allowed to manage the target's current role.
  //   2. Caller must be allowed to assign the requested new role.
  //   3. Last super_admin cannot be demoted (separate check below).
  const targetRole = await getTargetRole(params.id, params.userId)
  if (!targetRole) {
    return NextResponse.json({ error: 'Target member not found in this group.' }, { status: 404 })
  }
  if (!canManageRole(callerRole, targetRole)) {
    return NextResponse.json(
      { error: `Your role (${callerRole}) cannot modify a ${targetRole}.` },
      { status: 403 },
    )
  }
  if (!canAssignRole(callerRole, newRole)) {
    return NextResponse.json(
      { error: `Your role (${callerRole}) cannot assign the ${newRole} role.` },
      { status: 403 },
    )
  }

  // Protect last super_admin from demotion
  if (newRole !== 'super_admin') {
    const isLast = await checkLastSuperAdmin(params.id, params.userId)
    if (isLast) {
      return NextResponse.json(
        { error: 'Cannot demote the last super_admin. Promote another member first.' },
        { status: 422 }
      )
    }
  }

  const admin = createAdminClient()
  const { error } = await admin
    .from('user_groups')
    .update({ role: newRole })
    .eq('group_id', params.id)
    .eq('user_id', params.userId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data: { user_id: params.userId, role: newRole } })
}

export async function DELETE(_request: Request, { params }: Params) {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const access = await verifyAdminAccess(params.id, session.user.id, activeGroupId)
  if (access.status === 'not_found') return NextResponse.json({ error: 'Group not found' },     { status: 404 })
  if (access.status === 'forbidden') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  const callerRole = access.role

  // Same hierarchy gate as PATCH — only callers with sufficient rank can
  // remove a member at the target rank.
  const targetRole = await getTargetRole(params.id, params.userId)
  if (!targetRole) {
    return NextResponse.json({ error: 'Target member not found in this group.' }, { status: 404 })
  }
  if (!canManageRole(callerRole, targetRole)) {
    return NextResponse.json(
      { error: `Your role (${callerRole}) cannot remove a ${targetRole}.` },
      { status: 403 },
    )
  }

  // Protect last super_admin from removal
  const isLast = await checkLastSuperAdmin(params.id, params.userId)
  if (isLast) {
    return NextResponse.json(
      { error: 'Cannot remove the last super_admin.' },
      { status: 422 }
    )
  }

  const admin = createAdminClient()
  const { error } = await admin
    .from('user_groups')
    .delete()
    .eq('group_id', params.id)
    .eq('user_id', params.userId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data: { user_id: params.userId } })
}
