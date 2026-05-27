import { NextResponse }      from 'next/server'
import { cookies }            from 'next/headers'
import { createClient }       from '@/lib/supabase/server'
import { createAdminClient }  from '@/lib/supabase/admin'

export const runtime = 'nodejs'

const ADMIN_ROLES = ['super_admin', 'group_owner', 'group_admin']

function slugify(input: string): string {
  return input
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'skill'
}

async function verifyGroupAdmin(userId: string, groupId: string): Promise<boolean> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('user_groups')
    .select('role')
    .eq('user_id', userId)
    .eq('group_id', groupId)
    .single()
  return !!data && ADMIN_ROLES.includes((data as { role: string }).role)
}

async function getActiveGroup(): Promise<string | null> {
  const cookieStore = cookies()
  return cookieStore.get('active_group_id')?.value ?? null
}

// ── GET /api/settings/skills ─────────────────────────────────────────────────
// Returns:
//   • assigned: skills attached to this group via group_skills (with their
//     definitions). Includes platform-tier skills the group has assigned.
//   • own:      group-tier skills owned by this group (regardless of
//     assignment — these are the ones the admin can edit).
//   • available_platform: platform-tier published skills NOT yet assigned to
//     this group, so the picker can offer them.
export async function GET() {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const groupId = await getActiveGroup()
  if (!groupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  if (!await verifyGroupAdmin(session.user.id, groupId)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const admin = createAdminClient()

  const SKILL_COLS = 'id, tier, group_id, name, slug, category, description, instructions, tool_grants, is_active, is_published, version, updated_at'

  const [{ data: assignments }, { data: ownGroupSkills }, { data: platformSkills }] = await Promise.all([
    admin.from('group_skills')
      .select(`id, sort_order, skill_id, skills(${SKILL_COLS})`)
      .eq('group_id', groupId)
      .order('sort_order', { ascending: true }),
    admin.from('skills')
      .select(SKILL_COLS)
      .eq('tier', 'group')
      .eq('group_id', groupId)
      .order('updated_at', { ascending: false }),
    admin.from('skills')
      .select(SKILL_COLS)
      .eq('tier', 'platform')
      .eq('is_published', true)
      .eq('is_active', true)
      .order('name', { ascending: true }),
  ])

  const assignedSkillIds = new Set(((assignments ?? []) as Array<{ skill_id: string }>).map(a => a.skill_id))
  const availablePlatform = ((platformSkills ?? []) as Array<{ id: string }>)
    .filter(s => !assignedSkillIds.has(s.id))

  return NextResponse.json({
    data: {
      assigned:           assignments         ?? [],
      own:                ownGroupSkills      ?? [],
      available_platform: availablePlatform,
    },
  })
}

// ── POST /api/settings/skills ────────────────────────────────────────────────
// Two operating modes via body.action:
//   action='assign'        body: { skill_id }
//     → adds an existing platform/group skill to group_skills
//   action='create_group'  body: full skill payload (no id, no tier)
//     → creates a new tier='group' skill scoped to active group, then
//       auto-assigns it to group_skills
export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const groupId = await getActiveGroup()
  if (!groupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  if (!await verifyGroupAdmin(session.user.id, groupId)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  let body: Record<string, unknown>
  try { body = await request.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const admin  = createAdminClient()
  const action = typeof body.action === 'string' ? body.action : 'assign'

  if (action === 'assign') {
    const skillId = typeof body.skill_id === 'string' ? body.skill_id : ''
    if (!skillId) return NextResponse.json({ error: 'skill_id required' }, { status: 400 })

    // Determine next sort_order
    const { data: existing } = await admin
      .from('group_skills')
      .select('sort_order')
      .eq('group_id', groupId)
      .order('sort_order', { ascending: false })
      .limit(1)
    const nextOrder = ((existing?.[0] as { sort_order?: number } | undefined)?.sort_order ?? -1) + 1

    const { data, error } = await admin
      .from('group_skills')
      .insert({ group_id: groupId, skill_id: skillId, sort_order: nextOrder })
      .select('*, skills(*)')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ data }, { status: 201 })
  }

  if (action === 'create_group') {
    const name         = typeof body.name         === 'string' ? body.name.trim()         : ''
    const description  = typeof body.description  === 'string' ? body.description.trim()  : ''
    const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : ''
    if (!name || !description || !instructions) {
      return NextResponse.json(
        { error: 'name, description and instructions are required' },
        { status: 400 },
      )
    }

    const slugRaw = typeof body.slug === 'string' && body.slug.trim() ? body.slug.trim() : name
    const slug    = slugify(slugRaw)

    const { data: createdSkill, error: createErr } = await admin
      .from('skills')
      .insert({
        tier:           'group',
        group_id:       groupId,
        name,
        slug,
        category:       typeof body.category    === 'string' ? body.category : null,
        description,
        instructions,
        knowledge_text: typeof body.knowledge_text === 'string' ? body.knowledge_text : null,
        examples:       typeof body.examples       === 'string' ? body.examples       : null,
        tool_grants:    Array.isArray(body.tool_grants)
          ? (body.tool_grants as unknown[]).filter((x): x is string => typeof x === 'string')
          : [],
        is_active:      true,
        is_published:   true,    // group skills don't need separate publish step
        version:        1,
        created_by:     session.user.id,
      })
      .select('*')
      .single()
    if (createErr) return NextResponse.json({ error: createErr.message }, { status: 500 })

    // Auto-assign to this group.
    const { data: existing } = await admin
      .from('group_skills')
      .select('sort_order')
      .eq('group_id', groupId)
      .order('sort_order', { ascending: false })
      .limit(1)
    const nextOrder = ((existing?.[0] as { sort_order?: number } | undefined)?.sort_order ?? -1) + 1

    await admin
      .from('group_skills')
      .insert({ group_id: groupId, skill_id: (createdSkill as { id: string }).id, sort_order: nextOrder })

    return NextResponse.json({ data: createdSkill }, { status: 201 })
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
}
