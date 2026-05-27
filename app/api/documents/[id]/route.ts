import { NextResponse } from 'next/server'
import { cookies }       from 'next/headers'
import { createClient }  from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  getValidSharePointToken,
  ensureSharePointFolder,
  uploadFileToSharePoint,
  getNavHubFolderPath,
} from '@/lib/sharepoint'
import { exportToDocx } from '@/lib/document-export'
import type { Document } from '@/lib/types'

// ─── GET — single document ──────────────────────────────────────────────────

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('id', params.id)
    .eq('group_id', activeGroupId ?? '')
    .single()

  if (error || !data) return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  return NextResponse.json({ data })
}

// ─── PATCH — update document ────────────────────────────────────────────────

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  // Verify ownership via RLS
  const { data: existing } = await supabase
    .from('documents')
    .select('id, content_markdown')
    .eq('id', params.id)
    .eq('group_id', activeGroupId ?? '')
    .single()
  if (!existing) return NextResponse.json({ error: 'Document not found' }, { status: 404 })

  let body: Record<string, unknown>
  try { body = await request.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const admin = createAdminClient()

  // Auto-version if content is changing
  if (body.content_markdown !== undefined && body.content_markdown !== existing.content_markdown) {
    // Count existing versions to determine next version number
    const { count } = await admin
      .from('document_versions')
      .select('id', { count: 'exact', head: true })
      .eq('document_id', params.id)

    void admin.from('document_versions').insert({
      document_id:      params.id,
      content_markdown: existing.content_markdown,
      version:          (count ?? 0) + 1,
      created_by:       session.user.id,
    })
  }

  // Sanitise tags if provided
  if (Array.isArray(body.tags)) {
    body.tags = (body.tags as string[])
      .map((t: string) => String(t).toLowerCase().trim().slice(0, 40))
      .filter((t: string) => t.length > 0)
      .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
  }

  const allowedFields = [
    'title', 'document_type', 'audience', 'content_markdown',
    'status', 'folder_id', 'company_id', 'locked_by', 'locked_at', 'tags',
  ]
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of allowedFields) {
    if (key in body) updates[key] = body[key]
  }

  const { data, error } = await admin
    .from('documents')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Auto-sync to SharePoint if content changed OR doc was just published.
  // Run INLINE (awaited) — Vercel serverless functions terminate as soon as
  // NextResponse is returned, killing fire-and-forget `void (async ...)()` blocks
  // before they complete. Adds ~500ms to the response but ensures sync actually runs.
  let syncError: string | null = null
  if (
    ((body.content_markdown !== undefined && body.content_markdown !== existing.content_markdown) ||
     body.status === 'published') &&
    activeGroupId
  ) {
    console.log('[SharePoint] Starting sync for document:', data.id, 'status:', body.status)
    try {
      const { data: conn } = await admin
        .from('sharepoint_connections')
        .select('*')
        .eq('group_id', activeGroupId)
        .eq('is_active', true)
        .maybeSingle()

      if (conn && conn.drive_id) {
        // Look up folder mapping — folder-specific first, then group default
        const docFolderId = data.folder_id as string | null
        const { data: mapping } = await admin
          .from('folder_sharepoint_mappings')
          .select('sharepoint_path')
          .eq('group_id', activeGroupId)
          .or(docFolderId ? `folder_id.eq.${docFolderId},folder_id.is.null` : 'folder_id.is.null')
          .order('folder_id', { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle()

        const { access_token }    = await getValidSharePointToken(conn.id)
        const { data: groupData } = await admin.from('groups').select('name').eq('id', activeGroupId).single()
        const groupName           = groupData?.name ?? 'NavHub'

        // Determine file content: uploaded file or generated DOCX
        let fileBuffer: Buffer
        let filename:   string
        let mimeType:   string
        const docData = data as Record<string, unknown>

        if (docData.file_path) {
          const { data: fileData } = await admin.storage.from('documents').download(docData.file_path as string)
          fileBuffer = Buffer.from(await fileData!.arrayBuffer())
          filename   = (docData.file_name as string) ?? 'document'
          mimeType   = (docData.file_type as string) ?? 'application/octet-stream'
        } else {
          fileBuffer = await exportToDocx(data as Document, groupName)
          const safeName = (data.title as string).replace(/[^a-zA-Z0-9 \-_]/g, '').trim() || 'Document'
          filename   = `${safeName}.docx`
          mimeType   = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        }

        const rootPath   = conn.folder_path ?? 'NavHub'
        const folderName = data.folder_id
          ? ((await admin.from('document_folders').select('name').eq('id', data.folder_id).single()).data?.name ?? 'Unfiled')
          : 'Unfiled'
        const folderPath = mapping?.sharepoint_path ?? getNavHubFolderPath(rootPath, folderName)
        const folderId   = await ensureSharePointFolder(access_token, conn.drive_id, folderPath)

        const uploaded = await uploadFileToSharePoint(
          access_token, conn.drive_id, folderId, filename, fileBuffer, mimeType,
        )

        await admin.from('document_sharepoint_sync').upsert({
          document_id:        params.id,
          connection_id:      conn.id,
          sharepoint_item_id: uploaded.id,
          sharepoint_url:     uploaded.webUrl,
          last_synced_at:     new Date().toISOString(),
          sync_status:        'synced',
          error_message:      null,
        }, { onConflict: 'document_id' })

        console.log('[SharePoint] Sync complete for document:', data.id)
      } else {
        console.log('[SharePoint] Skipping sync — no active connection or drive_id for group')
      }
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err)
      console.error('[SharePoint] Sync error for document', data.id, ':', syncError)
      // Record the failure — non-blocking ok here, the response carries syncError.
      await admin.from('document_sharepoint_sync').upsert({
        document_id:    params.id,
        sync_status:    'failed',
        error_message:  syncError,
        last_synced_at: new Date().toISOString(),
      }, { onConflict: 'document_id' })
    }
  }

  return NextResponse.json({ data, syncError })
}

// ─── DELETE — delete document (admin only) ──────────────────────────────────

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  // Verify ownership + admin role
  const { data: existing } = await supabase
    .from('documents')
    .select('id')
    .eq('id', params.id)
    .eq('group_id', activeGroupId ?? '')
    .single()
  if (!existing) return NextResponse.json({ error: 'Document not found' }, { status: 404 })

  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId ?? '')
    .single()

  const isAdmin = membership?.role === 'super_admin' || membership?.role === 'group_owner' || membership?.role === 'group_admin'
  if (!isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const admin = createAdminClient()
  const { error } = await admin.from('documents').delete().eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data: { deleted: true } })
}
