import { NextResponse }     from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * DELETE /api/settings/provider-configs/[provider]
 * Soft-removes the provider's API key for the active group (is_active=false).
 */
export async function DELETE(_req: Request, { params }: { params: { provider: string } }) {
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
  const { error } = await admin
    .from('group_provider_configs')
    .update({ is_active: false })
    .eq('group_id', activeGroupId)
    .eq('provider', params.provider)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
