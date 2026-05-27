import { NextResponse }      from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

const ADMIN_ROLES = ['super_admin', 'group_owner', 'group_admin']

// ─── GET /api/reports/custom/[id] ────────────────────────────────────────────
// Returns report metadata (name, description, tags, etc.)
// Any group member can access.

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const supabase      = createClient()
    const cookieStore   = cookies()
    const activeGroupId = cookieStore.get('active_group_id')?.value

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

    const admin = createAdminClient()

    const { data: report, error } = await admin
      .from('custom_reports')
      .select('id, name, description, file_type, tags, is_shareable, created_at, updated_at')
      .eq('id', params.id)
      .eq('group_id', activeGroupId)
      .eq('is_active', true)
      .single()

    console.log('Report query:', { 
      id: params.id, 
      activeGroupId, 
      error: error?.message, 
      found: !!report 
    })

    if (error || !report) {
      return NextResponse.json({ error: 'Report not found' }, { status: 404 })
    }

    return NextResponse.json({ data: report })
  } catch (err) {
    const message = err instanceof Error
      ? err.message
      : typeof err === 'object'
        ? JSON.stringify(err)
        : String(err)
    console.error('Report GET error:', message)
    return NextResponse.json({ error: 'Internal server error', detail: message }, { status: 500 })
  }
}

// ─── PATCH /api/reports/custom/[id] ──────────────────────────────────────────
// Updates mutable report fields. Currently supports: tags (string[]).
// Requires group_admin or super_admin role.

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
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

  const admin = createAdminClient()

  // Verify report belongs to group
  const { data: existing } = await admin
    .from('custom_reports')
    .select('id')
    .eq('id', params.id)
    .eq('group_id', activeGroupId)
    .eq('is_active', true)
    .single()

  if (!existing) {
    return NextResponse.json({ error: 'Report not found' }, { status: 404 })
  }

  const body = await request.json() as Record<string, unknown>
  const updates: Record<string, unknown> = {}

  if (Array.isArray(body.tags)) {
    const sanitised = (body.tags as string[])
      .map((t: string) => t.toLowerCase().trim())
      .filter((t: string) => t.length > 0 && t.length <= 40)
    updates.tags = sanitised.filter((v, i, a) => a.indexOf(v) === i)
  }

  if (typeof body.status === 'string' && ['draft', 'published'].includes(body.status)) {
    updates.status = body.status
  }

  if (typeof body.name === 'string' && body.name.trim()) {
    updates.name = body.name.trim()
  }

  if (typeof body.description === 'string') {
    updates.description = body.description.trim() || null
  }

  if ('folder_id' in body) {
    updates.folder_id = body.folder_id ?? null
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  const { data: updated, error } = await admin
    .from('custom_reports')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', params.id)
    .select('id, name, tags')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data: updated })
}

// ─── DELETE /api/reports/custom/[id] ─────────────────────────────────────────
// Soft-deletes the report record + hard-deletes the Storage file.
// Requires group_admin or super_admin role.

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
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

  const admin = createAdminClient()

  // Fetch the report to get file_path and verify group ownership
  const { data: report } = await admin
    .from('custom_reports')
    .select('file_path, group_id')
    .eq('id', params.id)
    .eq('group_id', activeGroupId)
    .single()

  if (!report) {
    return NextResponse.json({ error: 'Report not found' }, { status: 404 })
  }

  // Soft-delete the DB record
  const { error: dbError } = await admin
    .from('custom_reports')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', params.id)

  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 })

  // Hard-delete from Storage (best-effort — don't fail the response on storage error)
  await admin.storage.from('report-files').remove([report.file_path])

  return NextResponse.json({ data: { id: params.id } })
}
