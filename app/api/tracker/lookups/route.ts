import { NextResponse } from 'next/server'
import { getTrackerContext } from '@/lib/tracker/server'
import { writeErrorResponse, strOrNull, keyFromLabel, uniqueKey } from '@/lib/tracker/api'

// The seven editable lists (data model section 5). The DB CHECK constraint
// enforces this too; listing them here gives a clear 422 before the round-trip.
const LISTS = ['category', 'status', 'milestone_status', 'action_type', 'source', 'region', 'review_step']

// POST /api/tracker/lookups — add a value to a list. The caller supplies a
// label; the key is auto-generated from it (lowercase, spaces → underscores,
// unique within the list) and never changes thereafter. Runs as the signed-in
// user, so RLS (editors only, migration 082) decides.
export async function POST(request: Request) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase, groupId } = ctx

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const list = typeof body.list === 'string' ? body.list : ''
  const label = strOrNull(body.label)
  if (!LISTS.includes(list)) {
    return NextResponse.json({ error: 'Unknown list' }, { status: 422 })
  }
  if (!label) {
    return NextResponse.json({ error: 'A label is required' }, { status: 422 })
  }

  const base = keyFromLabel(label)
  if (!base) {
    return NextResponse.json({ error: 'The label needs at least one letter or number' }, { status: 422 })
  }

  // Existing keys and the next sort order for this list, read as the signed-in
  // user (same RLS scope the write will use).
  const { data: existingRows, error: readErr } = await supabase
    .from('tracker_lookups')
    .select('key, sort_order')
    .eq('group_id', groupId)
    .eq('list', list)
  if (readErr) return writeErrorResponse(readErr)

  const existing = new Set<string>((existingRows ?? []).map((r) => (r.key as string).toLowerCase()))
  const key = uniqueKey(base, existing)
  const nextOrder =
    (existingRows ?? []).reduce((max, r) => Math.max(max, (r.sort_order as number) ?? 0), -1) + 1

  const { data, error } = await supabase
    .from('tracker_lookups')
    .insert({ group_id: groupId, list, key, label, sort_order: nextOrder, active: true })
    .select('id, list, key, label, sort_order, active')
    .single()

  if (error) return writeErrorResponse(error)

  return NextResponse.json({ data }, { status: 201 })
}
