import { NextResponse } from 'next/server'
import { cookies }      from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { ForecastStream } from '@/lib/types'

// ─── GET /api/forecast/streams ────────────────────────────────────────────────
// Returns all active forecast_streams for the active group, sorted by sort_order.
//
// ─── POST /api/forecast/streams ───────────────────────────────────────────────
// Creates a new stream. Requires group_admin or super_admin role.
// Body: { name, tag, color, y1_baseline, default_growth_rate, default_gp_margin }

const ADMIN_ROLES = ['super_admin', 'group_owner', 'group_admin']

async function getSessionAndGroup() {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  return { supabase, session, activeGroupId }
}

export async function GET() {
  const { supabase, session, activeGroupId } = await getSessionAndGroup()

  if (!session) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }
  if (!activeGroupId) {
    return NextResponse.json({ error: 'No active group' }, { status: 400 })
  }

  const { data: streams, error } = await supabase
    .from('forecast_streams')
    .select('*')
    .eq('group_id', activeGroupId)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data: (streams ?? []) as ForecastStream[] })
}

export async function POST(request: Request) {
  const { supabase, session, activeGroupId } = await getSessionAndGroup()

  if (!session) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }
  if (!activeGroupId) {
    return NextResponse.json({ error: 'No active group' }, { status: 400 })
  }

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

  let body: Record<string, unknown>
  try { body = await request.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { name, tag, color, y1_baseline, default_growth_rate, default_gp_margin } = body

  if (!name || typeof name !== 'string') {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  // Get current max sort_order
  const { data: existing } = await supabase
    .from('forecast_streams')
    .select('sort_order')
    .eq('group_id', activeGroupId)
    .eq('is_active', true)
    .order('sort_order', { ascending: false })
    .limit(1)

  const nextSortOrder = existing?.[0]?.sort_order != null ? (existing[0].sort_order as number) + 1 : 0

  const admin = createAdminClient()
  const { data: stream, error } = await admin
    .from('forecast_streams')
    .insert({
      group_id:            activeGroupId,
      name:                String(name),
      tag:                 tag != null ? String(tag) : 'Revenue',
      color:               color != null ? String(color) : '#4ade80',
      y1_baseline:         Number(y1_baseline ?? 0),
      default_growth_rate: Number(default_growth_rate ?? 20),
      default_gp_margin:   Number(default_gp_margin ?? 40),
      sort_order:          nextSortOrder,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data: stream as ForecastStream }, { status: 201 })
}
