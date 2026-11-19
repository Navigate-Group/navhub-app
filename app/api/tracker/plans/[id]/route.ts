import { NextResponse } from 'next/server'
import { getTrackerContext } from '@/lib/tracker/server'
import { writeErrorResponse, strOrNull, intInRange } from '@/lib/tracker/api'

// PATCH /api/tracker/plans/[id] — update a plan.
// Body variants:
//   { archive: true }            → set archived_at = now()  (editors only, DB-guarded)
//   { archive: false }           → clear archived_at         (editors only, DB-guarded)
//   { status: '...' }            → quick status change
//   { ...fields }                → full edit (name, category, client, …)
// All permission rules are enforced by RLS + the plan-guard trigger (082); a
// refusal is shown as a clear 403 message.
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase } = ctx
  const planId = params.id

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}

  if (typeof body.archive === 'boolean') {
    patch.archived_at = body.archive ? new Date().toISOString() : null
  } else {
    // Only copy the fields that were actually supplied so a status-only change
    // doesn't blank everything else.
    if ('name' in body) {
      const name = strOrNull(body.name)
      if (!name) return NextResponse.json({ error: 'A project name is required' }, { status: 422 })
      patch.name = name
    }
    if ('category' in body) {
      const category = strOrNull(body.category)
      if (!category) return NextResponse.json({ error: 'A category is required' }, { status: 422 })
      patch.category = category
    }
    if ('status' in body) patch.status = strOrNull(body.status)
    if ('client' in body) patch.client = strOrNull(body.client)
    if ('phase' in body) patch.phase = strOrNull(body.phase)
    if ('summary' in body) patch.summary = strOrNull(body.summary)
    if ('folder' in body) patch.folder = strOrNull(body.folder)
    if ('region' in body) patch.region = strOrNull(body.region)
    if ('parent_id' in body) {
      const parentId = strOrNull(body.parent_id)
      if (parentId === planId) {
        return NextResponse.json({ error: 'A project cannot be its own parent' }, { status: 422 })
      }
      patch.parent_id = parentId
    }
    if ('owner_id' in body) patch.owner_id = strOrNull(body.owner_id)
    if ('lead_id' in body) patch.lead_id = strOrNull(body.lead_id)
    if ('start_on' in body) patch.start_on = strOrNull(body.start_on)
    if ('end_on' in body) patch.end_on = strOrNull(body.end_on)
    if ('priority' in body) patch.priority = strOrNull(body.priority) ?? 'normal'
    if ('progress_pct' in body) patch.progress_pct = intInRange(body.progress_pct, 0, 100) ?? 0
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('tracker_project_plans')
    .update(patch)
    .eq('id', planId)
    .select('id')

  if (error) return writeErrorResponse(error)
  // An empty result means RLS blocked the update (the row was invisible or not
  // editable to this user).
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "You don't have permission to change this project" },
      { status: 403 },
    )
  }
  return NextResponse.json({ data: data[0] })
}

// DELETE /api/tracker/plans/[id] — permanently delete a plan.
// RLS restricts this to the plan's owner who is also an editor (082).
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase } = ctx

  const { data, error } = await supabase
    .from('tracker_project_plans')
    .delete()
    .eq('id', params.id)
    .select('id')

  if (error) return writeErrorResponse(error)
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "You don't have permission to delete this project" },
      { status: 403 },
    )
  }
  return NextResponse.json({ ok: true })
}
