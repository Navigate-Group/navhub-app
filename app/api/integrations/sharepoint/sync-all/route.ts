import { NextResponse }       from 'next/server'
import { cookies }             from 'next/headers'
import { createClient }        from '@/lib/supabase/server'
import { createAdminClient }   from '@/lib/supabase/admin'
import {
  getValidSharePointToken,
  ensureSharePointFolder,
  uploadFileToSharePoint,
  getNavHubFolderPath,
} from '@/lib/sharepoint'
import { exportToDocx } from '@/lib/document-export'
import type { Document } from '@/lib/types'

export const runtime     = 'nodejs'
export const maxDuration = 300

/**
 * POST /api/integrations/sharepoint/sync-all
 *
 * Bulk-syncs all published, active documents in the active group to SharePoint
 * using the per-folder mapping or auto-mirrored NavHub folder structure.
 *
 * Returns: { synced: number, failed: number, errors: string[] }
 *
 * Admin only.
 */
export async function POST() {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  // Admin only
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

  // Fetch SharePoint connection
  const { data: conn } = await admin
    .from('sharepoint_connections')
    .select('*')
    .eq('group_id', activeGroupId)
    .eq('is_active', true)
    .maybeSingle()

  if (!conn) return NextResponse.json({ error: 'No active SharePoint connection' }, { status: 422 })
  if (!conn.drive_id) return NextResponse.json({ error: 'SharePoint drive not configured' }, { status: 422 })

  // Group name for DOCX header
  const { data: group } = await admin
    .from('groups')
    .select('name')
    .eq('id', activeGroupId)
    .single()
  const groupName = group?.name ?? 'NavHub'

  // List all published, active documents for the group
  const { data: documents, error: docsError } = await admin
    .from('documents')
    .select('*')
    .eq('group_id', activeGroupId)
    .eq('status', 'published')

  if (docsError) return NextResponse.json({ error: docsError.message }, { status: 500 })
  if (!documents || documents.length === 0) {
    return NextResponse.json({ synced: 0, failed: 0, errors: [], total: 0 })
  }

  // Fetch all explicit folder mappings once
  const { data: mappings } = await admin
    .from('folder_sharepoint_mappings')
    .select('folder_id, sharepoint_path')
    .eq('group_id', activeGroupId)
  const mappingByFolder: Record<string, string> = {}
  let groupDefaultPath: string | null = null
  for (const m of mappings ?? []) {
    if (m.folder_id) mappingByFolder[m.folder_id as string] = m.sharepoint_path as string
    else groupDefaultPath = m.sharepoint_path as string
  }

  // Fetch all folder names once for auto-mirror path resolution
  const { data: folders } = await admin
    .from('document_folders')
    .select('id, name')
    .eq('group_id', activeGroupId)
  const folderNameById: Record<string, string> = {}
  for (const f of folders ?? []) folderNameById[f.id as string] = f.name as string

  let synced = 0
  let failed = 0
  const errors: string[] = []

  // Get a single fresh token for the whole batch (refreshes once if expiring)
  let accessToken: string
  try {
    const { access_token } = await getValidSharePointToken(conn.id)
    accessToken = access_token
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Token refresh failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  // Cache folder IDs by path so we don't re-create them per document
  const folderIdByPath: Record<string, string> = {}

  for (const doc of documents) {
    const document = doc as Document
    try {
      // Resolve target path: explicit mapping → group default → auto-mirror
      let targetPath: string
      if (document.folder_id && mappingByFolder[document.folder_id]) {
        targetPath = mappingByFolder[document.folder_id]
      } else if (groupDefaultPath) {
        targetPath = groupDefaultPath
      } else {
        const rootPath = (conn.folder_path as string | null) ?? 'NavHub'
        const folderName = document.folder_id ? (folderNameById[document.folder_id] ?? null) : null
        targetPath = getNavHubFolderPath(rootPath, folderName)
      }

      // Ensure folder (cached)
      let folderId = folderIdByPath[targetPath]
      if (!folderId) {
        folderId = await ensureSharePointFolder(accessToken, conn.drive_id, targetPath)
        folderIdByPath[targetPath] = folderId
      }

      // Build buffer + filename
      const docxBuffer = await exportToDocx(document, groupName)
      const safeName   = (document.title ?? 'Document').replace(/[^a-zA-Z0-9 \-_]/g, '').trim() || 'Document'
      const filename   = `${safeName}.docx`

      const uploaded = await uploadFileToSharePoint(
        accessToken,
        conn.drive_id,
        folderId,
        filename,
        docxBuffer,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      )

      void admin.from('document_sharepoint_sync').upsert({
        document_id:        document.id,
        connection_id:      conn.id,
        sharepoint_item_id: uploaded.id,
        sharepoint_url:     uploaded.webUrl,
        last_synced_at:     new Date().toISOString(),
        sync_status:        'synced',
      }, { onConflict: 'document_id' })

      synced += 1
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      errors.push(`${document.title ?? document.id}: ${msg}`)
      failed += 1

      void admin.from('document_sharepoint_sync').upsert({
        document_id:    document.id,
        connection_id:  conn.id,
        last_synced_at: new Date().toISOString(),
        sync_status:    'error',
        error_message:  msg,
      }, { onConflict: 'document_id' })
    }
  }

  return NextResponse.json({
    synced,
    failed,
    total: documents.length,
    errors: errors.slice(0, 20),
  })
}
