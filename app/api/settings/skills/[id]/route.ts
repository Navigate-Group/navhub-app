import { NextResponse }      from 'next/server'
import { cookies }            from 'next/headers'
import { createClient }       from '@/lib/supabase/server'
import { createAdminClient }  from '@/lib/supabase/admin'

export const runtime = 'nodejs'

const ADMIN_ROLES = ['super_admin', 'group_owner', 'group_admin']

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

type Params = { params: { id: string } }

// ── PATCH /api/settings/skills/[id] ─────────────────────────────────────────
// The [id] is the group_skills row id (assignment) — body { sort_order? }
// reorders the row, body { skill: { ... } } edits the underlying group-tier
// skill (only if it belongs to this group).
export async function PATCH(request: Request, { params }: Params) {
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

  const admin = createAdminClient()

  // Verify the assignment row belongs to this group.
  const { data: assignment } = await admin
    .from('group_skills')
    .select('id, skill_id')
    .eq('id', params.id)
    .eq('group_id', groupId)
    .single()
  if (!assignment) return NextResponse.json({ error: 'Assignment not found' }, { status: 404 })

  if (typeof body.sort_order === 'number') {
    const { error } = await admin
      .from('group_skills')
      .update({ sort_order: body.sort_order })
      .eq('id', params.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (body.skill && typeof body.skill === 'object') {
    const skillUpdates: Record<string, unknown> = {}
    const s = body.skill as Record<string, unknown>
    for (const k of ['name', 'category', 'description', 'instructions', 'knowledge_text', 'examples']) {
      if (typeof s[k] === 'string') skillUpdates[k] = s[k]
      else if (s[k] === null)        skillUpdates[k] = null
    }
    if (Array.isArray(s.tool_grants)) {
      skillUpdates.tool_grants = (s.tool_grants as unknown[]).filter((x): x is string => typeof x === 'string')
    }
    if (typeof s.is_active === 'boolean') skillUpdates.is_active = s.is_active

    if (Object.keys(skillUpdates).length > 0) {
      // Only allowed when the underlying skill is tier='group' AND owned
      // by this group — never on platform-tier skills.
      const skillId = (assignment as { skill_id: string }).skill_id
      const { data: skill } = await admin
        .from('skills')
        .select('tier, group_id, version')
        .eq('id', skillId)
        .single()
      if (!skill || (skill as { tier: string }).tier !== 'group' || (skill as { group_id: string }).group_id !== groupId) {
        return NextResponse.json({ error: 'Cannot edit a platform skill from group settings' }, { status: 403 })
      }
      skillUpdates.version    = ((skill as { version?: number }).version ?? 1) + 1
      skillUpdates.updated_at = new Date().toISOString()
      const { error } = await admin
        .from('skills')
        .update(skillUpdates)
        .eq('id', skillId)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
  }

  return NextResponse.json({ data: { id: params.id, ok: true } })
}

// ── DELETE /api/settings/skills/[id] ────────────────────────────────────────
// Removes the assignment. If body.purge_skill is true and the skill is a
// group-tier skill owned by this group, also deletes the underlying skill.
export async function DELETE(request: Request, { params }: Params) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const groupId = await getActiveGroup()
  if (!groupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })
  if (!await verifyGroupAdmin(session.user.id, groupId)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const url        = new URL(request.url)
  const purgeSkill = url.searchParams.get('purge_skill') === 'true'

  const admin = createAdminClient()
  const { data: assignment } = await admin
    .from('group_skills')
    .select('id, skill_id, skills(tier, group_id)')
    .eq('id', params.id)
    .eq('group_id', groupId)
    .single()
  if (!assignment) return NextResponse.json({ error: 'Assignment not found' }, { status: 404 })

  await admin.from('group_skills').delete().eq('id', params.id)

  if (purgeSkill) {
    const skill = (assignment as unknown as { skills: { tier: string; group_id: string | null } | null }).skills
    if (skill && skill.tier === 'group' && skill.group_id === groupId) {
      await admin.from('skills').delete().eq('id', (assignment as { skill_id: string }).skill_id)
    }
  }

  return NextResponse.json({ data: { id: params.id, deleted: true } })
}
