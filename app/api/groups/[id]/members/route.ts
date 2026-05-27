import { NextResponse }      from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { GroupMember }  from '@/lib/types'

// ─── GET /api/groups/[id]/members ────────────────────────────────────────────
// Returns all members of a group (email + role).
// Requires group_admin or super_admin role.
// super_admin can view any group's members (not limited to activeGroupId).

const ADMIN_ROLES = ['super_admin', 'group_owner', 'group_admin']

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const supabase      = createClient()
    const cookieStore   = cookies()
    const activeGroupId = cookieStore.get('active_group_id')?.value

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    // Verify caller is admin in their active group
    const { data: membership } = await supabase
      .from('user_groups')
      .select('role')
      .eq('user_id', session.user.id)
      .eq('group_id', activeGroupId ?? '')
      .single()

    if (!membership || !ADMIN_ROLES.includes(membership.role)) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    // super_admin can view any group; others are restricted to their active group
    const isSuperAdmin = membership.role === 'super_admin'
    if (!isSuperAdmin && params.id !== activeGroupId) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    }

    const admin = createAdminClient()

    // Get all user_groups rows for this group
    const { data: userGroups, error } = await admin
      .from('user_groups')
      .select('user_id, role, is_default')
      .eq('group_id', params.id)

    if (error) throw error

    // Fetch user emails using auth admin API with error handling per user
    const members: GroupMember[] = await Promise.all(
      (userGroups ?? []).map(async (ug: {
        user_id: string; role: string; is_default: boolean
      }) => {
        let email = ''
        try {
          const { data } = await admin.auth.admin.getUserById(ug.user_id)
          email = data.user?.email ?? ''
        } catch {
          email = ''
        }
        return {
          user_id:    ug.user_id,
          email,
          role:       ug.role,
          is_default: ug.is_default,
          joined_at:  '',
        }
      })
    )

    return NextResponse.json({ data: members })
  } catch (err) {
    const message = err instanceof Error
      ? err.message
      : typeof err === 'object'
        ? JSON.stringify(err)
        : String(err)
    console.error('Members API error:', message)
    return NextResponse.json({ error: 'Internal server error', detail: message }, { status: 500 })
  }
}