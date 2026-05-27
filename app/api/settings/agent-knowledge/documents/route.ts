import { NextResponse }     from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * POST /api/settings/agent-knowledge/documents
 * Body (JSON): { document_id: string }    — link an existing document
 *  -- or --
 * multipart: file                          — upload a new file (storage bucket 'documents')
 *
 * Admin only.
 */

export const runtime = 'nodejs'

async function adminGuard(supabase: ReturnType<typeof createClient>, userId: string, groupId: string) {
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', userId)
    .eq('group_id', groupId)
    .single()
  return !!membership && ['super_admin', 'group_owner', 'group_admin'].includes(membership.role)
}

export async function POST(req: Request) {
  const supabase     = createClient()
  const cookieStore  = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  const { data: { session } } = await supabase.auth.getSession()
  if (!session)       return NextResponse.json({ error: 'Unauthorized' },    { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })
  if (!(await adminGuard(supabase, session.user.id, activeGroupId))) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const admin = createAdminClient()
  const contentType = req.headers.get('content-type') ?? ''

  // ── Path 1: link existing document ───────────────────────────────────────
  if (contentType.includes('application/json')) {
    const body = await req.json() as { document_id?: string }
    if (!body.document_id) return NextResponse.json({ error: 'document_id required' }, { status: 400 })

    const { data: doc } = await admin
      .from('documents')
      .select('id, title, file_type, file_name, group_id')
      .eq('id', body.document_id)
      .eq('group_id', activeGroupId)
      .maybeSingle()
    if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 })

    const { data, error } = await admin
      .from('group_agent_knowledge_documents')
      .insert({
        group_id:    activeGroupId,
        document_id: doc.id,
        file_name:   doc.file_name ?? doc.title,
        file_type:   doc.file_type ?? 'text/markdown',
      })
      .select('id, group_id, document_id, file_path, file_name, file_type, created_at')
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ data: { ...data, document_title: doc.title } }, { status: 201 })
  }

  // ── Path 2: upload new file ──────────────────────────────────────────────
  const formData = await req.formData()
  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 })

  const safeName = file.name.replace(/[^a-zA-Z0-9._\-]/g, '_')
  const filePath = `${activeGroupId}/group-knowledge/${Date.now()}_${safeName}`
  const buffer   = Buffer.from(await file.arrayBuffer())

  const { error: upErr } = await admin.storage
    .from('documents')
    .upload(filePath, buffer, { contentType: file.type, upsert: false })
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })

  const { data, error } = await admin
    .from('group_agent_knowledge_documents')
    .insert({
      group_id:  activeGroupId,
      file_path: filePath,
      file_name: file.name,
      file_type: file.type || 'application/octet-stream',
    })
    .select('id, group_id, document_id, file_path, file_name, file_type, created_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data }, { status: 201 })
}
