import { NextResponse } from 'next/server'
import { cookies }      from 'next/headers'
import { createClient } from '@/lib/supabase/server'

// ─── GET /api/groups/active ──────────────────────────────────────────────────
// Returns the active group details for the current user,
// their role, and whether they are a group admin.
// Used by the settings page to pre-fill group info client-side.
export async function GET() {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }
  if (!activeGroupId) {
    return NextResponse.json({ error: 'No active group' }, { status: 400 })
  }

  const { data: group } = await supabase
    .from('groups')
    .select('id, name, slug, primary_color, palette_id, web_search_enabled, timezone, location, brand_name, brand_color, logo_url, max_task_complexity')
    .eq('id', activeGroupId)
    .single()

  if (!group) {
    return NextResponse.json({ error: 'Group not found' }, { status: 404 })
  }

  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId)
    .single()

  const adminRoles = ['super_admin', 'group_owner', 'group_admin']
  const isAdmin    = !!membership && adminRoles.includes(membership.role)

  // Pull a display name for the dashboard greeting from user_metadata
  // (set during invite acceptance) — falls back to the email's local part.
  const meta     = (session.user.user_metadata ?? {}) as { full_name?: string; name?: string }
  const fullName = (meta.full_name ?? meta.name ?? '').trim()
  const userName = fullName || (session.user.email?.split('@')[0] ?? '')

  return NextResponse.json({
    data: {
      group,
      role:       membership?.role ?? null,
      is_admin:   isAdmin,
      user_email: session.user.email,
      user_name:  userName,
    },
  })
}
