import { NextResponse }      from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { PALETTES, getPalette } from '@/lib/themes'

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/

type Params = { params: { id: string } }

// ─── PATCH /api/groups/[id] ──────────────────────────────────────────────────
// Updates mutable group fields: name, palette_id.
// Requires group_admin or super_admin role.
// Body: { name?, palette_id? }
export async function PATCH(request: Request, { params }: Params) {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  // Only allow updating the active group (prevents cross-group tampering)
  if (params.id !== activeGroupId) {
    return NextResponse.json({ error: 'Group not found' }, { status: 404 })
  }

  // Verify the user has admin rights in this group
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', params.id)
    .single()

  const adminRoles = ['super_admin', 'group_owner', 'group_admin']
  if (!membership || !adminRoles.includes(membership.role)) {
    return NextResponse.json({ error: 'Forbidden — group admin required' }, { status: 403 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const updates: Record<string, unknown> = {}

  if (typeof body.name === 'string') {
    const name = body.name.trim()
    if (name.length < 2) {
      return NextResponse.json({ error: 'Group name must be at least 2 characters' }, { status: 422 })
    }
    updates.name = name
  }

  if (typeof body.slug === 'string') {
    const slug = body.slug.trim().toLowerCase()
    if (slug.length < 2) {
      return NextResponse.json({ error: 'Slug must be at least 2 characters' }, { status: 422 })
    }
    if (!SLUG_RE.test(slug)) {
      return NextResponse.json(
        { error: 'Slug may only contain lowercase letters, numbers, and hyphens (no leading/trailing hyphens)' },
        { status: 422 }
      )
    }
    // Check uniqueness (exclude current group)
    const admin = createAdminClient()
    const { data: slugConflict } = await admin
      .from('groups')
      .select('id')
      .eq('slug', slug)
      .neq('id', params.id)
      .single()
    if (slugConflict) {
      return NextResponse.json({ error: 'This slug is already taken. Choose a different one.' }, { status: 409 })
    }
    updates.slug = slug
  }

  if (typeof body.palette_id === 'string') {
    const paletteId = body.palette_id.trim()
    const validIds  = PALETTES.map(p => p.id)
    if (!validIds.includes(paletteId)) {
      return NextResponse.json(
        { error: `palette_id must be one of: ${validIds.join(', ')}` },
        { status: 422 }
      )
    }
    // Derive and persist primary_color from palette for backwards-compat
    const palette           = getPalette(paletteId)
    updates.palette_id      = paletteId
    updates.primary_color   = palette.primary
  }

  if ('web_search_enabled' in body) {
    updates.web_search_enabled = !!body.web_search_enabled
  }

  // Max task complexity (migration 054) — caps the highest tier users can
  // pick on the run launcher. Validated against the same enum as the
  // CHECK constraint.
  if ('max_task_complexity' in body) {
    const v = typeof body.max_task_complexity === 'string' ? body.max_task_complexity : ''
    if (!['standard', 'medium', 'large', 'massive', 'professional'].includes(v)) {
      return NextResponse.json(
        { error: 'max_task_complexity must be one of: standard, medium, large, massive, professional' },
        { status: 400 },
      )
    }
    updates.max_task_complexity = v
  }

  if ('timezone' in body) {
    if (typeof body.timezone === 'string' && body.timezone.trim()) {
      updates.timezone = body.timezone.trim()
    }
  }

  if ('location' in body) {
    if (body.location === null) {
      updates.location = null
    } else if (typeof body.location === 'string') {
      updates.location = body.location.trim() || null
    }
  }

  // ── Branding (migration 047) ─────────────────────────────────────────────
  if ('brand_name' in body) {
    if (body.brand_name === null) {
      updates.brand_name = null
    } else if (typeof body.brand_name === 'string') {
      const v = body.brand_name.trim()
      if (v.length > 30) {
        return NextResponse.json({ error: 'Brand name max 30 characters' }, { status: 422 })
      }
      updates.brand_name = v || null
    }
  }
  if ('brand_color' in body) {
    if (body.brand_color === null) {
      updates.brand_color = null
    } else if (typeof body.brand_color === 'string') {
      const v = body.brand_color.trim()
      if (!/^#[0-9a-fA-F]{6}$/.test(v)) {
        return NextResponse.json({ error: 'brand_color must be a #RRGGBB hex value' }, { status: 422 })
      }
      updates.brand_color = v.toLowerCase()
    }
  }
  if ('logo_url' in body) {
    // Only allow nulling here; uploads go through /api/groups/[id]/logo
    if (body.logo_url === null) updates.logo_url = null
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 422 })
  }

  const admin = createAdminClient()
  const { data: group, error } = await admin
    .from('groups')
    .update(updates)
    .eq('id', params.id)
    .select('id, name, slug, primary_color, palette_id, web_search_enabled, timezone, location, brand_name, brand_color, logo_url')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data: group })
}
