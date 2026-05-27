import { NextResponse }     from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { KnowledgeLink } from '@/lib/types'

/**
 * GET   /api/settings/agent-knowledge   → fetch universal knowledge for active group
 * PATCH /api/settings/agent-knowledge   → upsert knowledge_text + knowledge_links
 */

async function adminGuard(supabase: ReturnType<typeof createClient>, userId: string, groupId: string) {
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', userId)
    .eq('group_id', groupId)
    .single()
  return !!membership && ['super_admin', 'group_owner', 'group_admin'].includes(membership.role)
}

export async function GET() {
  const supabase     = createClient()
  const cookieStore  = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  const { data: { session } } = await supabase.auth.getSession()
  if (!session)       return NextResponse.json({ error: 'Unauthorized' },    { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const admin = createAdminClient()
  const [knowRes, docsRes] = await Promise.all([
    admin
      .from('group_agent_knowledge')
      .select('id, group_id, knowledge_text, knowledge_links, updated_at')
      .eq('group_id', activeGroupId)
      .maybeSingle(),
    admin
      .from('group_agent_knowledge_documents')
      .select('id, group_id, document_id, file_path, file_name, file_type, created_at, documents(title)')
      .eq('group_id', activeGroupId)
      .order('created_at', { ascending: false }),
  ])

  const knowledge = knowRes.data ?? {
    id:              null,
    group_id:        activeGroupId,
    knowledge_text:  null,
    knowledge_links: [],
    updated_at:      new Date().toISOString(),
  }

  const documents = (docsRes.data ?? []).map(d => ({
    id:             d.id,
    group_id:       d.group_id,
    document_id:    d.document_id,
    file_path:      d.file_path,
    file_name:      d.file_name,
    file_type:      d.file_type,
    created_at:     d.created_at,
    document_title: (d.documents as { title?: string } | null)?.title ?? null,
  }))

  return NextResponse.json({ data: { knowledge, documents } })
}

export async function PATCH(req: Request) {
  const supabase     = createClient()
  const cookieStore  = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  const { data: { session } } = await supabase.auth.getSession()
  if (!session)       return NextResponse.json({ error: 'Unauthorized' },    { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })
  if (!(await adminGuard(supabase, session.user.id, activeGroupId))) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const body = await req.json() as {
    knowledge_text?:  string | null
    knowledge_links?: KnowledgeLink[]
  }

  const admin = createAdminClient()
  const { data: existing } = await admin
    .from('group_agent_knowledge')
    .select('id')
    .eq('group_id', activeGroupId)
    .maybeSingle()

  const payload: Record<string, unknown> = {
    group_id:   activeGroupId,
    updated_by: session.user.id,
    updated_at: new Date().toISOString(),
  }
  if (body.knowledge_text !== undefined)  payload.knowledge_text  = body.knowledge_text
  if (body.knowledge_links !== undefined) payload.knowledge_links = body.knowledge_links ?? []

  let result
  if (existing) {
    result = await admin
      .from('group_agent_knowledge')
      .update(payload)
      .eq('id', existing.id)
      .select('id, group_id, knowledge_text, knowledge_links, updated_at')
      .single()
  } else {
    result = await admin
      .from('group_agent_knowledge')
      .insert(payload)
      .select('id, group_id, knowledge_text, knowledge_links, updated_at')
      .single()
  }

  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 })
  return NextResponse.json({ data: result.data })
}
