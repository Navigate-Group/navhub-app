import { NextResponse }      from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { randomBytes }       from 'crypto'

const ADMIN_ROLES = ['super_admin', 'group_owner', 'group_admin']

type Params = { params: { id: string } }

// ─── GET /api/reports/custom/[id]/share ──────────────────────────────────────
// Returns sharing status for this report.
// Admin only. Returns { is_shareable, share_url, created_at }.

export async function GET(
  _request: Request,
  { params }: Params
) {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

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
  const { data: report } = await admin
    .from('custom_reports')
    .select('id, is_shareable, share_token, share_token_created_at')
    .eq('id', params.id)
    .eq('group_id', activeGroupId)
    .eq('is_active', true)
    .single()

  if (!report) {
    return NextResponse.json({ error: 'Report not found' }, { status: 404 })
  }

  const appUrl   = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.navhub.co'
  const shareUrl = report.is_shareable && report.share_token
    ? `${appUrl}/view/report/${params.id}?token=${report.share_token}`
    : null

  return NextResponse.json({
    data: {
      is_shareable: report.is_shareable,
      share_url:    shareUrl,
      created_at:   report.share_token_created_at ?? null,
    },
  })
}

// ─── POST /api/reports/custom/[id]/share ─────────────────────────────────────
// Generates a share token for this report.
// Admin only. Idempotent — re-calling regenerates the token.

export async function POST(
  _request: Request,
  { params }: Params
) {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId)
    .single()

  if (!membership || !ADMIN_ROLES.includes(membership.role)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  // Verify the report exists and belongs to the active group
  const { data: existing } = await supabase
    .from('custom_reports')
    .select('id')
    .eq('id', params.id)
    .eq('group_id', activeGroupId)
    .eq('is_active', true)
    .single()

  if (!existing) {
    return NextResponse.json({ error: 'Report not found' }, { status: 404 })
  }

  const token    = randomBytes(32).toString('hex')
  const now      = new Date().toISOString()
  const appUrl   = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.navhub.co'
  const shareUrl = `${appUrl}/view/report/${params.id}?token=${token}`

  const admin = createAdminClient()
  const { error } = await admin
    .from('custom_reports')
    .update({
      is_shareable:           true,
      share_token:            token,
      share_token_created_at: now,
    })
    .eq('id', params.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    data: {
      is_shareable: true,
      share_url:    shareUrl,
      created_at:   now,
    },
  })
}

// ─── DELETE /api/reports/custom/[id]/share ────────────────────────────────────
// Revokes share access. Clears token so existing links stop working immediately.
// Admin only.

export async function DELETE(
  _request: Request,
  { params }: Params
) {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId)
    .single()

  if (!membership || !ADMIN_ROLES.includes(membership.role)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { data: existing } = await supabase
    .from('custom_reports')
    .select('id')
    .eq('id', params.id)
    .eq('group_id', activeGroupId)
    .eq('is_active', true)
    .single()

  if (!existing) {
    return NextResponse.json({ error: 'Report not found' }, { status: 404 })
  }

  const admin = createAdminClient()
  const { error } = await admin
    .from('custom_reports')
    .update({
      is_shareable:           false,
      share_token:            null,
      share_token_created_at: null,
    })
    .eq('id', params.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data: { is_shareable: false } })
}
