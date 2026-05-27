import { NextResponse }      from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

const ADMIN_ROLES = ['super_admin', 'group_owner', 'group_admin']

// ─── PATCH /api/reports/custom/[id]/content ───────────────────────────────────
// Overwrites the report's HTML file in Supabase Storage with the modified content.
// Body: { html: string }
// Requires group_admin or super_admin role.

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  // Auth check
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  // Admin role check
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId)
    .single()

  if (!membership || !ADMIN_ROLES.includes(membership.role)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  // Parse body
  let body: { html?: string } = {}
  try { body = await request.json() as { html?: string } } catch { /* ignore */ }

  if (typeof body.html !== 'string' || body.html.trim().length === 0) {
    return NextResponse.json({ error: 'html is required' }, { status: 400 })
  }

  // Fetch report to get file_path (RLS ensures group ownership)
  const { data: report } = await supabase
    .from('custom_reports')
    .select('file_path, group_id')
    .eq('id', params.id)
    .eq('group_id', activeGroupId)
    .eq('is_active', true)
    .single()

  if (!report) {
    return NextResponse.json({ error: 'Report not found' }, { status: 404 })
  }

  const admin = createAdminClient()

  // Overwrite the existing file in Storage
  const { error: storageError } = await admin.storage
    .from('report-files')
    .update(report.file_path, Buffer.from(body.html, 'utf-8'), {
      contentType: 'text/html',
      upsert:      true,
    })

  if (storageError) {
    return NextResponse.json({ error: storageError.message }, { status: 500 })
  }

  // Refresh updated_at on the DB record
  await admin
    .from('custom_reports')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', params.id)

  return NextResponse.json({ success: true })
}
