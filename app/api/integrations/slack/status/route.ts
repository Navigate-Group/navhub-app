import { NextResponse } from 'next/server'
import { cookies }       from 'next/headers'
import { createClient }  from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// ─── GET — return Slack connection status for active group ──────────────────

export async function GET() {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const configured = !!(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET)

  const admin = createAdminClient()
  const { data } = await admin
    .from('slack_connections')
    .select('id, team_id, team_name, default_channel, is_active, created_at')
    .eq('group_id', activeGroupId)
    .eq('is_active', true)
    .maybeSingle()

  return NextResponse.json({ data: data ?? null, configured })
}

// ─── PATCH — update default_channel ─────────────────────────────────────────

export async function PATCH(req: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId)
    .single()
  const isAdmin = membership?.role === 'super_admin' || membership?.role === 'group_owner' || membership?.role === 'group_admin'
  if (!isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const body = await req.json() as { default_channel?: string | null }
  const next = body.default_channel === null
    ? null
    : (typeof body.default_channel === 'string' ? body.default_channel.trim() || null : undefined)
  if (next === undefined) {
    return NextResponse.json({ error: 'default_channel is required' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { error } = await admin
    .from('slack_connections')
    .update({ default_channel: next })
    .eq('group_id', activeGroupId)
    .eq('is_active', true)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, default_channel: next })
}

// ─── DELETE — soft disconnect ───────────────────────────────────────────────

export async function DELETE() {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId)
    .single()
  const isAdmin = membership?.role === 'super_admin' || membership?.role === 'group_owner' || membership?.role === 'group_admin'
  if (!isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const admin = createAdminClient()
  await admin.from('slack_connections').update({ is_active: false }).eq('group_id', activeGroupId)

  return NextResponse.json({ data: { disconnected: true } })
}
