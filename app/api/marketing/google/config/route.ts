/**
 * PATCH /api/marketing/google/config
 * Update config fields (property_id / site_url) for an existing Google connection.
 * Body: { platform: 'ga4'|'search_console', company_id?: string, config: object }
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { createAdminClient }         from '@/lib/supabase/admin'
import { cookies }                   from 'next/headers'

export async function PATCH(req: NextRequest) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  // Admin check
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('group_id', activeGroupId)
    .eq('user_id', session.user.id)
    .single()
  if (!membership || !['super_admin', 'group_owner', 'group_admin'].includes(membership.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body      = await req.json() as { platform: string; company_id?: string; config: Record<string, unknown> }
  const { platform, company_id, config } = body

  if (!platform || !config) {
    return NextResponse.json({ error: 'platform and config required' }, { status: 400 })
  }

  const admin = createAdminClient()

  let query = admin
    .from('marketing_connections')
    .update({ config })
    .eq('group_id', activeGroupId)
    .eq('platform', platform)

  if (company_id) {
    query = query.eq('company_id', company_id)
  } else {
    query = query.is('company_id', null)
  }

  const { error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
