import { NextResponse }      from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// ─── DELETE /api/groups/[id]/invites/[inviteId] ───────────────────────────────
// Cancels a pending invite.

const ADMIN_ROLES = ['super_admin', 'group_owner', 'group_admin']

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string; inviteId: string } }
) {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (params.id !== activeGroupId) return NextResponse.json({ error: 'Group not found' }, { status: 404 })

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
  const { error } = await admin
    .from('group_invites')
    .delete()
    .eq('id', params.inviteId)
    .eq('group_id', params.id)  // Scoped to this group

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data: { id: params.inviteId } })
}
