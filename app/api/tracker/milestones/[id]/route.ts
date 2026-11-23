import { NextResponse } from 'next/server'
import { getTrackerContext } from '@/lib/tracker/server'
import { writeErrorResponse, strOrNull, intInRange } from '@/lib/tracker/api'

// PATCH /api/tracker/milestones/[id] — edit a milestone.
// Only the fields present in the body are changed. Editing due_on preserves the
// original baseline_due_on (migration 085); only the milestone's owner or a
// Manager / Group Owner may change baseline_due_on (guard in 085 — surfaces as a
// clear 42501 message). Setting status to 'completed' records completed_on;
// reopening clears it (085 trigger). All access is enforced by RLS (082).
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase } = ctx
  const milestoneId = params.id

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}
  if ('title' in body) {
    const title = strOrNull(body.title)
    if (!title) return NextResponse.json({ error: 'A milestone title is required' }, { status: 422 })
    patch.title = title
  }
  if ('description' in body) patch.description = strOrNull(body.description)
  if ('owner_id' in body) patch.owner_id = strOrNull(body.owner_id)
  if ('status' in body) patch.status = strOrNull(body.status) ?? 'backlog'
  if ('health' in body) patch.health = strOrNull(body.health) ?? 'on_track'
  if ('priority' in body) patch.priority = strOrNull(body.priority) ?? 'normal'
  if ('start_on' in body) patch.start_on = strOrNull(body.start_on)
  if ('due_on' in body) patch.due_on = strOrNull(body.due_on)
  if ('baseline_due_on' in body) patch.baseline_due_on = strOrNull(body.baseline_due_on)
  if ('progress_mode' in body) {
    patch.progress_mode = strOrNull(body.progress_mode) === 'from_actions' ? 'from_actions' : 'manual'
  }
  if ('progress_pct' in body) patch.progress_pct = intInRange(body.progress_pct, 0, 100) ?? 0

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('tracker_milestones')
    .update(patch)
    .eq('id', milestoneId)
    .select('id')

  if (error) return writeErrorResponse(error)
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "You don't have permission to change this" },
      { status: 403 },
    )
  }
  return NextResponse.json({ data: { id: milestoneId } })
}

// DELETE /api/tracker/milestones/[id] — delete a milestone.
// RLS restricts this to Managers / Group Owners (082).
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase } = ctx

  const { data, error } = await supabase
    .from('tracker_milestones')
    .delete()
    .eq('id', params.id)
    .select('id')

  if (error) return writeErrorResponse(error)
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "You don't have permission to delete this" },
      { status: 403 },
    )
  }
  return NextResponse.json({ ok: true })
}
