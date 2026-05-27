import { NextResponse }     from 'next/server'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * POST   /api/groups/[id]/logo
 *   Multipart form-data: file
 *   Validates PNG/SVG/WebP/JPEG, max 1 MB.
 *   Uploads to Storage bucket "branding" at {group_id}/logo.{ext}.
 *   Updates groups.logo_url to the public URL.
 *
 * DELETE /api/groups/[id]/logo
 *   Clears groups.logo_url and removes any objects under {group_id}/.
 *
 * Admin only.
 */

export const runtime = 'nodejs'

const ACCEPTED = new Set([
  'image/png',
  'image/svg+xml',
  'image/webp',
  'image/jpeg',
  'image/jpg',
])
const MAX_BYTES = 1 * 1024 * 1024

const EXT_FROM_MIME: Record<string, string> = {
  'image/png':     'png',
  'image/svg+xml': 'svg',
  'image/webp':    'webp',
  'image/jpeg':    'jpg',
  'image/jpg':     'jpg',
}

async function adminGuard(supabase: ReturnType<typeof createClient>, userId: string, groupId: string) {
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', userId)
    .eq('group_id', groupId)
    .single()
  return !!membership && ['super_admin', 'group_owner', 'group_admin'].includes(membership.role)
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await adminGuard(supabase, session.user.id, params.id))) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 })

  if (!ACCEPTED.has(file.type)) {
    return NextResponse.json({ error: 'Unsupported file type. Use PNG, SVG, WebP or JPEG.' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File too large. Max 1 MB.' }, { status: 400 })
  }

  const ext     = EXT_FROM_MIME[file.type] ?? 'png'
  const path    = `${params.id}/logo.${ext}`
  const buffer  = Buffer.from(await file.arrayBuffer())
  const admin   = createAdminClient()

  const { error: upErr } = await admin.storage
    .from('branding')
    .upload(path, buffer, { contentType: file.type, upsert: true })

  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })

  // Public URL — bucket should be configured public for direct <img src>.
  const { data: urlData } = admin.storage.from('branding').getPublicUrl(path)
  // Append cache-buster so the browser refreshes after re-upload.
  const publicUrl = `${urlData.publicUrl}?t=${Date.now()}`

  const { error: updErr } = await admin
    .from('groups')
    .update({ logo_url: publicUrl })
    .eq('id', params.id)
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  return NextResponse.json({ data: { logo_url: publicUrl } }, { status: 201 })
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await adminGuard(supabase, session.user.id, params.id))) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const admin = createAdminClient()

  // Best-effort: list and remove any logo files under {group_id}/
  try {
    const { data: list } = await admin.storage.from('branding').list(params.id)
    if (list && list.length > 0) {
      const paths = list.map(f => `${params.id}/${f.name}`)
      void admin.storage.from('branding').remove(paths)
    }
  } catch { /* ignore — DB clear is the source of truth */ }

  const { error } = await admin
    .from('groups')
    .update({ logo_url: null })
    .eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
