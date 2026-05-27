import { NextResponse }        from 'next/server'
import { cookies }              from 'next/headers'
import { createClient }         from '@/lib/supabase/server'
import { createAdminClient }    from '@/lib/supabase/admin'
import { randomBytes }          from 'crypto'

async function verifyAdminAccess(session: { user: { id: string } }, activeGroupId: string) {
  const supabase = createClient()
  const { data } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId)
    .single()
  return data?.role === 'super_admin' || data?.role === 'group_owner' || data?.role === 'group_admin'
}

// ─── GET — share status ─────────────────────────────────────────────────────

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value ?? ''

  const { data: doc } = await supabase
    .from('documents')
    .select('is_shareable, share_token, share_token_created_at')
    .eq('id', params.id)
    .eq('group_id', activeGroupId)
    .single()
  if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 })

  const appUrl  = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const shareUrl = doc.is_shareable && doc.share_token
    ? `${appUrl}/view/document/${params.id}?token=${doc.share_token as string}`
    : null

  return NextResponse.json({
    data: {
      is_shareable: doc.is_shareable,
      share_url:    shareUrl,
      created_at:   doc.share_token_created_at,
    },
  })
}

// ─── POST — generate / refresh share token ──────────────────────────────────

export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value ?? ''

  if (!await verifyAdminAccess(session, activeGroupId)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { data: doc } = await supabase
    .from('documents')
    .select('id')
    .eq('id', params.id)
    .eq('group_id', activeGroupId)
    .single()
  if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 })

  const token    = randomBytes(32).toString('hex')
  const now      = new Date().toISOString()
  const admin    = createAdminClient()

  await admin.from('documents').update({
    is_shareable:           true,
    share_token:            token,
    share_token_created_at: now,
  }).eq('id', params.id)

  const appUrl  = process.env.NEXT_PUBLIC_APP_URL ?? ''
  return NextResponse.json({
    data: {
      is_shareable: true,
      share_url:    `${appUrl}/view/document/${params.id}?token=${token}`,
      created_at:   now,
    },
  })
}

// ─── DELETE — revoke share ──────────────────────────────────────────────────

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value ?? ''

  if (!await verifyAdminAccess(session, activeGroupId)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const admin = createAdminClient()
  await admin.from('documents').update({
    is_shareable:           false,
    share_token:            null,
    share_token_created_at: null,
  }).eq('id', params.id).eq('group_id', activeGroupId)

  return NextResponse.json({ data: { is_shareable: false } })
}
