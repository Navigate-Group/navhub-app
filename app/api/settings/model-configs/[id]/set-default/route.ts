import { NextResponse }     from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * POST /api/settings/model-configs/[id]/set-default
 * Promotes the given config to be the group's default.
 * (Convenience wrapper around PATCH with is_default=true.)
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase     = createClient()
  const cookieStore  = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  const { data: { session } } = await supabase.auth.getSession()
  if (!session)       return NextResponse.json({ error: 'Unauthorized' },    { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId)
    .single()
  if (!membership || !['super_admin', 'group_owner', 'group_admin'].includes(membership.role)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const admin = createAdminClient()

  // Verify the config belongs to this group
  const { data: existing } = await admin
    .from('group_model_configs')
    .select('id')
    .eq('id', params.id)
    .eq('group_id', activeGroupId)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Config not found' }, { status: 404 })

  // Clear current default(s), then set this one
  await admin
    .from('group_model_configs')
    .update({ is_default: false })
    .eq('group_id', activeGroupId)
    .eq('is_default', true)

  const { error } = await admin
    .from('group_model_configs')
    .update({ is_default: true })
    .eq('id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
