import { NextResponse }     from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * DELETE /api/settings/agent-knowledge/documents/[id]
 * Removes a universal-knowledge document. If it owns a Storage object (file_path
 * set), the Storage object is removed too.
 */
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
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
  const { data: existing } = await admin
    .from('group_agent_knowledge_documents')
    .select('id, file_path')
    .eq('id', params.id)
    .eq('group_id', activeGroupId)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (existing.file_path) {
    void admin.storage.from('documents').remove([existing.file_path])
  }

  const { error } = await admin
    .from('group_agent_knowledge_documents')
    .delete()
    .eq('id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
