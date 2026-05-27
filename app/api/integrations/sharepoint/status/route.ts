import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { cookies }            from 'next/headers'
import { NextResponse }       from 'next/server'

/**
 * GET /api/integrations/sharepoint/status
 * Returns SharePoint connection status for the active group.
 *
 * PATCH /api/integrations/sharepoint/status
 * Updates folder_path or drive_id for the connection.
 *
 * DELETE /api/integrations/sharepoint/status
 * Disconnects SharePoint (soft delete — sets is_active = false).
 */

export async function GET() {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const cookieStore = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const admin = createAdminClient()
  const { data } = await admin
    .from('sharepoint_connections')
    .select('id, group_id, is_active, site_url, drive_id, folder_path, tenant_id, token_expires_at')
    .eq('group_id', activeGroupId)
    .eq('is_active', true)
    .maybeSingle()

  const configured = !!(process.env.SHAREPOINT_CLIENT_ID && process.env.SHAREPOINT_CLIENT_SECRET)

  return NextResponse.json({ data: data ?? null, configured })
}

export async function PATCH(req: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const cookieStore = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  // Admin check
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId)
    .single()

  if (!membership || !['super_admin', 'group_owner', 'group_admin'].includes(membership.role)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const body = await req.json() as { folder_path?: string; drive_id?: string; site_url?: string }
  const updates: Record<string, string> = {}
  if (body.folder_path !== undefined) updates.folder_path = body.folder_path
  if (body.drive_id    !== undefined) updates.drive_id    = body.drive_id
  if (body.site_url    !== undefined) updates.site_url    = body.site_url

  const admin = createAdminClient()
  const { error } = await admin
    .from('sharepoint_connections')
    .update(updates)
    .eq('group_id', activeGroupId)
    .eq('is_active', true)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

export async function DELETE() {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const cookieStore = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  // Admin check
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
    .from('sharepoint_connections')
    .update({ is_active: false })
    .eq('group_id', activeGroupId)
    .eq('is_active', true)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
