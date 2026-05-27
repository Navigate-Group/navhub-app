import { NextResponse }      from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { CustomReport } from '@/lib/types'

const ADMIN_ROLES = ['super_admin', 'group_owner', 'group_admin']
const MAX_SIZE_BYTES = 5 * 1024 * 1024  // 5 MB

// ─── GET /api/reports/custom ──────────────────────────────────────────────────
// Returns all active custom reports for the active group, sorted by sort_order.

export async function GET(request: Request) {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const url      = new URL(request.url)
  const folderId = url.searchParams.get('folder_id')

  // Check user role for status filtering
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId)
    .single()

  const userRole = membership?.role ?? 'viewer'

  let query = supabase
    .from('custom_reports')
    .select('*')
    .eq('group_id', activeGroupId)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })

  if (folderId === 'unfiled') query = query.is('folder_id', null)
  else if (folderId)           query = query.eq('folder_id', folderId)

  // Viewers can only see published reports
  if (userRole === 'viewer') {
    query = query.eq('status', 'published')
  }

  const { data: reports, error } = await query

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data: (reports ?? []) as CustomReport[] })
}

// ─── POST /api/reports/custom ─────────────────────────────────────────────────
// Uploads a new custom HTML report.
// Accepts multipart/form-data: { file, name, description? }

export async function POST(request: Request) {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  // Verify admin role
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId)
    .single()

  if (!membership || !ADMIN_ROLES.includes(membership.role)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  let formData: FormData
  try { formData = await request.formData() }
  catch { return NextResponse.json({ error: 'Invalid form data' }, { status: 400 }) }

  const file        = formData.get('file')        as File | null
  const name        = formData.get('name')        as string | null
  const description = formData.get('description') as string | null

  if (!file) return NextResponse.json({ error: 'File is required' }, { status: 400 })
  if (!name || !name.trim()) return NextResponse.json({ error: 'Report name is required' }, { status: 400 })

  // Validate file type
  const filename  = file.name.toLowerCase()
  const isHtml    = filename.endsWith('.html') || filename.endsWith('.htm')
  if (!isHtml) {
    return NextResponse.json({ error: 'Only .html files are accepted' }, { status: 422 })
  }

  // Validate file size
  if (file.size > MAX_SIZE_BYTES) {
    return NextResponse.json({ error: 'File must be 5 MB or smaller' }, { status: 422 })
  }

  // Build storage path
  const sanitisedName = filename.replace(/[^a-z0-9._-]/g, '_')
  const timestamp     = Date.now()
  const filePath      = `${activeGroupId}/reports/${timestamp}_${sanitisedName}`

  // Upload to Storage
  const arrayBuffer = await file.arrayBuffer()
  const fileBuffer  = Buffer.from(arrayBuffer)

  const admin = createAdminClient()
  const { error: uploadError } = await admin.storage
    .from('report-files')
    .upload(filePath, fileBuffer, { contentType: 'text/html' })

  if (uploadError) {
    return NextResponse.json(
      { error: `Storage upload failed: ${uploadError.message}` },
      { status: 500 }
    )
  }

  // Get current max sort_order
  const { data: existing } = await supabase
    .from('custom_reports')
    .select('sort_order')
    .eq('group_id', activeGroupId)
    .eq('is_active', true)
    .order('sort_order', { ascending: false })
    .limit(1)

  const nextSortOrder = existing?.[0]?.sort_order != null ? (existing[0].sort_order as number) + 1 : 0

  // Insert record
  const { data: report, error: dbError } = await admin
    .from('custom_reports')
    .insert({
      group_id:    activeGroupId,
      name:        name.trim(),
      description: description?.trim() || null,
      file_path:   filePath,
      file_type:   'html',
      uploaded_by: session.user.id,
      sort_order:  nextSortOrder,
    })
    .select()
    .single()

  if (dbError) {
    // Roll back storage upload on db failure
    await admin.storage.from('report-files').remove([filePath])
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ data: report as CustomReport }, { status: 201 })
}
