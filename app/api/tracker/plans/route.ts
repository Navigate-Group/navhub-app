import { NextResponse } from 'next/server'
import { getTrackerContext, applyPlanMembers } from '@/lib/tracker/server'
import { writeErrorResponse, strOrNull, intInRange, strArray } from '@/lib/tracker/api'

// POST /api/tracker/plans — create a project plan.
// All guards (editor-only create, owner must be a Manager/Group Owner, lead
// must be a member, same-group parent) are enforced by RLS + triggers in the
// database (migration 082), run as the signed-in user via the server client.
export async function POST(request: Request) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase, userId, groupId } = ctx

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const name = strOrNull(body.name)
  const category = strOrNull(body.category)
  if (!name) return NextResponse.json({ error: 'A project name is required' }, { status: 422 })
  if (!category) return NextResponse.json({ error: 'A category is required' }, { status: 422 })

  // owner defaults to the creator; only editors may set a different owner (DB
  // enforces both the default and the "owner must be Manager/Group Owner" rule).
  const ownerId = strOrNull(body.owner_id) ?? userId

  const insert = {
    group_id: groupId,
    name,
    category,
    status: strOrNull(body.status),
    client: strOrNull(body.client),
    phase: strOrNull(body.phase),
    summary: strOrNull(body.summary),
    folder: strOrNull(body.folder),
    region: strOrNull(body.region),
    parent_id: strOrNull(body.parent_id),
    owner_id: ownerId,
    lead_id: strOrNull(body.lead_id),
    start_on: strOrNull(body.start_on),
    end_on: strOrNull(body.end_on),
    priority: strOrNull(body.priority) ?? 'normal',
    progress_pct: intInRange(body.progress_pct, 0, 100) ?? 0,
  }

  const { data, error } = await supabase
    .from('tracker_project_plans')
    .insert(insert)
    .select('id')
    .single()

  if (error) return writeErrorResponse(error)

  // Members (FR-2.1): write the chosen 'member' rows. Only Managers/Group
  // Owners may; the database refuses otherwise. member_ids is only present
  // when the form allowed editing it.
  const memberIds = strArray(body.member_ids)
  if (memberIds && data?.id) {
    const memberErr = await applyPlanMembers(supabase, data.id as string, memberIds)
    if (memberErr) {
      return NextResponse.json(
        { data, warning: 'The project was created, but its members could not be saved.' },
        { status: 201 },
      )
    }
  }

  return NextResponse.json({ data }, { status: 201 })
}
