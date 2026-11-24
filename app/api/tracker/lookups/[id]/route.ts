import { NextResponse } from 'next/server'
import { getTrackerContext } from '@/lib/tracker/server'
import { writeErrorResponse, strOrNull, intInRange } from '@/lib/tracker/api'

// PATCH /api/tracker/lookups/[id] — change a lookup value's label, its shown /
// hidden state, or its sort order. The key never changes (hide, don't delete).
// Runs as the signed-in user, so RLS (editors only, migration 082) decides.
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase, groupId } = ctx

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}

  if ('label' in body) {
    const label = strOrNull(body.label)
    if (!label) return NextResponse.json({ error: 'A label is required' }, { status: 422 })
    patch.label = label
  }

  if ('active' in body) {
    if (typeof body.active !== 'boolean') {
      return NextResponse.json({ error: 'active must be true or false' }, { status: 422 })
    }
    patch.active = body.active
  }

  if ('sort_order' in body) {
    const order = intInRange(body.sort_order, 0, 1_000_000)
    if (order === null) return NextResponse.json({ error: 'Invalid sort order' }, { status: 422 })
    patch.sort_order = order
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to change' }, { status: 422 })
  }

  // Scope to this group as well as the id, so the RLS-governed update can only
  // ever touch a row in the caller's current group.
  const { data, error } = await supabase
    .from('tracker_lookups')
    .update(patch)
    .eq('id', params.id)
    .eq('group_id', groupId)
    .select('id, list, key, label, sort_order, active')
    .maybeSingle()

  if (error) return writeErrorResponse(error)
  if (!data) return NextResponse.json({ error: 'That value could not be found' }, { status: 404 })

  return NextResponse.json({ data })
}
