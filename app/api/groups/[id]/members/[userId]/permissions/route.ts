import { NextResponse } from 'next/server'
import { cookies }       from 'next/headers'
import { createClient }  from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getUserPermissions, ADMIN_ROLES, canSetPermission } from '@/lib/permissions'
import type { AppRole, FeatureKey, AccessLevel } from '@/lib/types'

// ─── GET — get permissions for a specific user in this group ─────────────────

export async function GET(
  _request: Request,
  { params }: { params: { id: string; userId: string } },
) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  // Verify caller is admin of this group
  const { data: callerMembership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', params.id)
    .single()

  if (!callerMembership || !ADMIN_ROLES.includes(callerMembership.role as AppRole)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  // Get target user's role
  const admin = createAdminClient()
  const { data: targetMembership } = await admin
    .from('user_groups')
    .select('role')
    .eq('user_id', params.userId)
    .eq('group_id', params.id)
    .single()

  if (!targetMembership) return NextResponse.json({ error: 'User not found in group' }, { status: 404 })

  const matrix = await getUserPermissions(params.userId, params.id, targetMembership.role as AppRole)
  return NextResponse.json({ data: { matrix, role: targetMembership.role } })
}

// ─── PUT — replace all permissions for a user in this group ──────────────────

export async function PUT(
  request: Request,
  { params }: { params: { id: string; userId: string } },
) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const cookieStore = cookies()
  void cookieStore // ensure dynamic

  // Verify caller is admin
  const { data: callerMembership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', params.id)
    .single()

  if (!callerMembership || !ADMIN_ROLES.includes(callerMembership.role as AppRole)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  // Cannot modify other admins
  const admin = createAdminClient()
  const { data: targetMembership } = await admin
    .from('user_groups')
    .select('role')
    .eq('user_id', params.userId)
    .eq('group_id', params.id)
    .single()

  if (!targetMembership) return NextResponse.json({ error: 'User not found in group' }, { status: 404 })
  if (ADMIN_ROLES.includes(targetMembership.role as AppRole)) {
    return NextResponse.json({ error: 'Cannot modify permissions of admin users' }, { status: 422 })
  }

  let body: { permissions: Array<{ feature: FeatureKey; company_id: string | null; access: AccessLevel }> }
  try { body = await request.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  if (!Array.isArray(body.permissions)) {
    return NextResponse.json({ error: 'permissions array required' }, { status: 400 })
  }

  // Staff 'Admin only' guard: a group_admin cannot raise financials/marketing
  // above 'none' for a staff member — only group_owner / super_admin can.
  const callerRole = callerMembership.role as AppRole
  const targetRole = targetMembership.role as AppRole
  for (const p of body.permissions) {
    if (!canSetPermission(callerRole, targetRole, p.feature, p.access)) {
      return NextResponse.json(
        { error: `Only a group owner or super admin can grant ${p.feature} access to a staff member.` },
        { status: 403 },
      )
    }
  }

  // Delete existing permissions
  await admin
    .from('user_permissions')
    .delete()
    .eq('user_id', params.userId)
    .eq('group_id', params.id)

  // Insert new permissions (filter out 'none' — no need to store explicit none)
  const rows = body.permissions
    .filter(p => p.access !== 'none')
    .map(p => ({
      user_id:    params.userId,
      group_id:   params.id,
      feature:    p.feature,
      company_id: p.company_id,
      access:     p.access,
      updated_by: session.user.id,
      updated_at: new Date().toISOString(),
    }))

  if (rows.length > 0) {
    const { error } = await admin
      .from('user_permissions')
      .insert(rows)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Return updated matrix
  const matrix = await getUserPermissions(params.userId, params.id, targetMembership.role as AppRole)
  return NextResponse.json({ data: { matrix } })
}
