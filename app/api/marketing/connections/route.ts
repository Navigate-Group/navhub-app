/**
 * Marketing connections management API
 *
 * GET  /api/marketing/connections?company_id=...&platform=...
 *   → list active connections for the active group
 *
 * DELETE /api/marketing/connections?platform=...&company_id=...
 *   → disconnect (set is_active = false) — admin only
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { createAdminClient }         from '@/lib/supabase/admin'
import { cookies }                   from 'next/headers'

export async function GET(req: NextRequest) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const companyId = req.nextUrl.searchParams.get('company_id')
  const platform  = req.nextUrl.searchParams.get('platform')

  let query = supabase
    .from('marketing_connections')
    .select('id, group_id, company_id, platform, config, is_active, last_synced_at, access_token_expires_at, external_account_id, external_account_name, scope')
    .eq('group_id', activeGroupId)
    .eq('is_active', true)

  if (companyId) query = query.eq('company_id', companyId)
  if (platform)  query = query.eq('platform', platform)

  const { data, error } = await query.order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data })
}

export async function DELETE(req: NextRequest) {
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

  const platform  = req.nextUrl.searchParams.get('platform')
  const companyId = req.nextUrl.searchParams.get('company_id')

  if (!platform) return NextResponse.json({ error: 'platform required' }, { status: 400 })

  const admin = createAdminClient()

  let query = admin
    .from('marketing_connections')
    .update({ is_active: false })
    .eq('group_id', activeGroupId)
    .eq('platform', platform)

  if (companyId) {
    query = query.eq('company_id', companyId)
  } else {
    query = query.is('company_id', null)
  }

  const { error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
