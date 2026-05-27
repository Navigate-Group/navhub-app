import { NextResponse }      from 'next/server'
import { cookies }            from 'next/headers'
import { createClient }       from '@/lib/supabase/server'
import { createAdminClient }  from '@/lib/supabase/admin'

export const runtime = 'nodejs'

const ADMIN_ROLES = ['super_admin', 'group_owner', 'group_admin']

function slugify(input: string): string {
  return input.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'skill'
}

async function getActiveGroup(): Promise<string | null> {
  const cookieStore = cookies()
  return cookieStore.get('active_group_id')?.value ?? null
}

async function verifyAgentAdmin(userId: string, agentId: string, activeGroupId: string): Promise<{ ok: boolean; group_id?: string }> {
  const admin = createAdminClient()
  const { data: agent } = await admin
    .from('agents')
    .select('id, group_id')
    .eq('id', agentId)
    .single()
  if (!agent) return { ok: false }
  const agentGroupId = (agent as { group_id: string }).group_id
  if (agentGroupId !== activeGroupId) return { ok: false }

  const { data: membership } = await admin
    .from('user_groups')
    .select('role')
    .eq('user_id', userId)
    .eq('group_id', agentGroupId)
    .single()
  if (!membership || !ADMIN_ROLES.includes((membership as { role: string }).role)) return { ok: false }
  return { ok: true, group_id: agentGroupId }
}

type Params = { params: { id: string } }

// ── GET /api/agents/[id]/skills ──────────────────────────────────────────────
// Returns:
//   • assigned: agent_skills assignments for this agent (with skill defs)
//   • own:      agent-tier skills owned by this group (assignable + editable)
//   • inherited_platform: published platform skills (read-only context)
//   • inherited_group:    group-skills.assignments for this agent's group
//                         (read-only context — auto-applied)
export async function GET(_request: Request, { params }: Params) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const groupId = await getActiveGroup()
  if (!groupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const access = await verifyAgentAdmin(session.user.id, params.id, groupId)
  if (!access.ok) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const admin = createAdminClient()
  const SKILL_COLS = 'id, tier, group_id, name, slug, category, description, instructions, tool_grants, is_active, is_published, version, updated_at'

  const [{ data: assigned }, { data: own }, { data: platform }, { data: groupAssigned }] = await Promise.all([
    admin.from('agent_skills')
      .select(`id, sort_order, skill_id, skills(${SKILL_COLS})`)
      .eq('agent_id', params.id)
      .order('sort_order', { ascending: true }),
    admin.from('skills')
      .select(SKILL_COLS)
      .eq('tier', 'agent')
      .eq('group_id', groupId)
      .order('updated_at', { ascending: false }),
    admin.from('skills')
      .select(SKILL_COLS)
      .eq('tier', 'platform')
      .eq('is_published', true)
      .eq('is_active', true),
    admin.from('group_skills')
      .select(`sort_order, skills(${SKILL_COLS})`)
      .eq('group_id', groupId),
  ])

  return NextResponse.json({
    data: {
      assigned:           assigned ?? [],
      own:                own ?? [],
      inherited_platform: platform ?? [],
      inherited_group:    groupAssigned ?? [],
    },
  })
}

// ── POST /api/agents/[id]/skills ─────────────────────────────────────────────
// action='assign'        body: { skill_id }  → adds to agent_skills
// action='create_agent'  body: full skill payload → creates tier='agent'
//                         skill scoped to this group, then auto-assigns it
export async function POST(request: Request, { params }: Params) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const groupId = await getActiveGroup()
  if (!groupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const access = await verifyAgentAdmin(session.user.id, params.id, groupId)
  if (!access.ok) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  let body: Record<string, unknown>
  try { body = await request.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const admin  = createAdminClient()
  const action = typeof body.action === 'string' ? body.action : 'assign'

  async function nextSortOrder(): Promise<number> {
    const { data } = await admin
      .from('agent_skills')
      .select('sort_order')
      .eq('agent_id', params.id)
      .order('sort_order', { ascending: false })
      .limit(1)
    return ((data?.[0] as { sort_order?: number } | undefined)?.sort_order ?? -1) + 1
  }

  if (action === 'assign') {
    const skillId = typeof body.skill_id === 'string' ? body.skill_id : ''
    if (!skillId) return NextResponse.json({ error: 'skill_id required' }, { status: 400 })

    const { data, error } = await admin
      .from('agent_skills')
      .insert({ agent_id: params.id, skill_id: skillId, sort_order: await nextSortOrder() })
      .select('*, skills(*)')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ data }, { status: 201 })
  }

  if (action === 'create_agent') {
    const name         = typeof body.name         === 'string' ? body.name.trim()         : ''
    const description  = typeof body.description  === 'string' ? body.description.trim()  : ''
    const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : ''
    if (!name || !description || !instructions) {
      return NextResponse.json(
        { error: 'name, description and instructions are required' },
        { status: 400 },
      )
    }

    const { data: createdSkill, error: createErr } = await admin
      .from('skills')
      .insert({
        tier:           'agent',
        group_id:       groupId,
        name,
        slug:           slugify(typeof body.slug === 'string' && body.slug ? body.slug : name),
        category:       typeof body.category    === 'string' ? body.category : null,
        description,
        instructions,
        knowledge_text: typeof body.knowledge_text === 'string' ? body.knowledge_text : null,
        examples:       typeof body.examples       === 'string' ? body.examples       : null,
        tool_grants:    Array.isArray(body.tool_grants)
          ? (body.tool_grants as unknown[]).filter((x): x is string => typeof x === 'string')
          : [],
        is_active:      true,
        is_published:   true,
        version:        1,
        created_by:     session.user.id,
      })
      .select('*')
      .single()
    if (createErr) return NextResponse.json({ error: createErr.message }, { status: 500 })

    await admin
      .from('agent_skills')
      .insert({ agent_id: params.id, skill_id: (createdSkill as { id: string }).id, sort_order: await nextSortOrder() })

    return NextResponse.json({ data: createdSkill }, { status: 201 })
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
}

// ── DELETE /api/agents/[id]/skills?assignment_id=... ─────────────────────────
export async function DELETE(request: Request, { params }: Params) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const groupId = await getActiveGroup()
  if (!groupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const access = await verifyAgentAdmin(session.user.id, params.id, groupId)
  if (!access.ok) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const url           = new URL(request.url)
  const assignmentId  = url.searchParams.get('assignment_id')
  if (!assignmentId) {
    return NextResponse.json({ error: 'assignment_id query param required' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { error } = await admin
    .from('agent_skills')
    .delete()
    .eq('id', assignmentId)
    .eq('agent_id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data: { id: assignmentId, deleted: true } })
}
