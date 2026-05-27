import { NextResponse }     from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// ─── GET — list folders ─────────────────────────────────────────────────────

export async function GET() {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const { data, error } = await supabase
    .from('document_folders')
    .select('*')
    .eq('group_id', activeGroupId)
    .order('name')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data: data ?? [] })
}

// ─── POST — create folder ───────────────────────────────────────────────────

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  let body: Record<string, unknown>
  try { body = await request.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { name } = body
  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  // Admin check — only admins can create folders
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId)
    .single()

  const isAdmin = membership?.role === 'super_admin' || membership?.role === 'group_owner' || membership?.role === 'group_admin'
  if (!isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const admin = createAdminClient()
  const { data, error } = await admin.from('document_folders').insert({
    group_id:   activeGroupId,
    name:       name.trim(),
    created_by: session.user.id,
  }).select().single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data }, { status: 201 })
}

// ─── DELETE — delete folder ─────────────────────────────────────────────────

export async function DELETE(request: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const url = new URL(request.url)
  const id  = url.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  // Admin check
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId)
    .single()

  const isAdmin = membership?.role === 'super_admin' || membership?.role === 'group_owner' || membership?.role === 'group_admin'
  if (!isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  // Reject if folder has documents
  const { count } = await supabase
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('folder_id', id)

  if ((count ?? 0) > 0) {
    return NextResponse.json({ error: 'Cannot delete folder that contains documents' }, { status: 409 })
  }

  const admin = createAdminClient()
  await admin.from('document_folders').delete().eq('id', id).eq('group_id', activeGroupId)
  return NextResponse.json({ data: { deleted: true } })
}
