import { NextResponse }      from 'next/server'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getPalette }        from '@/lib/themes'
import { generateSlug }      from '@/lib/utils'



// ─── GET /api/groups ──────────────────────────────────────────────────────────
// Returns all groups the current user belongs to, with role + member/company counts.

export async function GET() {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  // Get user's group memberships + group details
  const { data: userGroups, error } = await supabase
    .from('user_groups')
    .select('group_id, role, is_default, groups(id, name, palette_id, primary_color)')
    .eq('user_id', session.user.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = userGroups ?? []
  if (rows.length === 0) {
    return NextResponse.json({ data: [] })
  }

  const groupIds = rows.map(r => r.group_id)
  const admin    = createAdminClient()

  // Fetch member counts + company counts in parallel (admin bypasses RLS)
  const [membersRes, companiesRes] = await Promise.all([
    admin.from('user_groups').select('group_id').in('group_id', groupIds),
    admin.from('companies').select('group_id').in('group_id', groupIds).eq('is_active', true),
  ])

  const memberMap: Record<string, number>  = {}
  const companyMap: Record<string, number> = {}

  ;(membersRes.data ?? []).forEach((m: { group_id: string }) => {
    memberMap[m.group_id] = (memberMap[m.group_id] ?? 0) + 1
  })
  ;(companiesRes.data ?? []).forEach((c: { group_id: string }) => {
    companyMap[c.group_id] = (companyMap[c.group_id] ?? 0) + 1
  })

  const data = rows.map(ug => {
    // Supabase returns joined relation as object or array — handle both
    const g = Array.isArray(ug.groups) ? ug.groups[0] : ug.groups
    return {
      id:            g?.id            ?? ug.group_id,
      name:          g?.name          ?? '',
      palette_id:    g?.palette_id    ?? 'ocean',
      primary_color: g?.primary_color ?? '#0ea5e9',
      role:          ug.role,
      is_default:    ug.is_default,
      member_count:  memberMap[ug.group_id]  ?? 0,
      company_count: companyMap[ug.group_id] ?? 0,
    }
  })

  return NextResponse.json({ data })
}

// ─── POST /api/groups ─────────────────────────────────────────────────────────
// Creates a new group. Adds creator as group_admin of the new group (or
// super_admin if they already hold super_admin elsewhere).
// Body: { name: string, palette_id?: string }

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  // Anyone authenticated can create a group, but they must be at least a
  // group_admin somewhere already (or hold super_admin platform-wide).
  // Brand-new accounts with zero memberships can also create their first
  // group — that's the onboarding path.
  const { data: roleRows } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
  const memberships = roleRows ?? []
  const isPlatformSuperAdmin = memberships.some(r => r.role === 'super_admin')
  const hasAnyAdminRole = memberships.some(r => ['super_admin', 'group_owner', 'group_admin'].includes(r.role))
  const isOnboarding = memberships.length === 0
  if (!hasAnyAdminRole && !isOnboarding) {
    return NextResponse.json(
      { error: 'Admin access required — only group admins can create new groups' },
      { status: 403 },
    )
  }

  let body: Record<string, unknown>
  try { body = await request.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const name      = typeof body.name === 'string' ? body.name.trim() : ''
  const paletteId = typeof body.palette_id === 'string' ? body.palette_id : 'ocean'

  if (name.length < 2) {
    return NextResponse.json({ error: 'Group name must be at least 2 characters' }, { status: 400 })
  }

  const palette   = getPalette(paletteId)
  const slug      = generateSlug(name)
  const admin     = createAdminClient()

  // Check slug uniqueness
  const { data: existing } = await admin
    .from('groups')
    .select('id')
    .eq('slug', slug)
    .single()

  if (existing) {
    return NextResponse.json(
      { error: 'A group with this name already exists. Try a different name.' },
      { status: 409 }
    )
  }

  // Determine if this will be the user's first (default) group — reuse the
  // earlier role-row fetch instead of round-tripping again.
  const isFirstGroup = memberships.length === 0

  // Create group — record the creator as owner_user_id (migration 062).
  // Platform super_admins keep their elevated role across tenants; everyone
  // else becomes the group_owner of the new tenant.
  const { data: group, error: groupError } = await admin
    .from('groups')
    .insert({
      name,
      slug,
      palette_id:    palette.id,
      primary_color: palette.primary,
      // Stamp BOTH columns: owner_id (migration 016, used by the admin
      // Groups page) and owner_user_id (migration 062).
      owner_id:      session.user.id,
      owner_user_id: session.user.id,
    })
    .select()
    .single()

  if (groupError || !group) {
    return NextResponse.json({ error: groupError?.message ?? 'Failed to create group' }, { status: 500 })
  }

  await admin.from('user_groups').insert({
    user_id:    session.user.id,
    group_id:   group.id,
    role:       isPlatformSuperAdmin ? 'super_admin' : 'group_owner',
    is_default: isFirstGroup,
  })

  // Auto-create system folders: Templates + Imports
  void admin.from('document_folders').insert([
    { group_id: group.id, name: 'Templates', is_system: true, folder_type: 'templates' },
    { group_id: group.id, name: 'Imports',   is_system: true, folder_type: 'imports'   },
  ])

  return NextResponse.json({ data: group }, { status: 201 })
}
