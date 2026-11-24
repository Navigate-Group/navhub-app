import { NextResponse } from 'next/server'
import { getTrackerContext } from '@/lib/tracker/server'
import { writeErrorResponse, strOrNull } from '@/lib/tracker/api'
import { addDays } from '@/lib/tracker/domain'

type Quick = 'done' | 'plus_day' | 'plus_week' | 'waiting' | 'back_to_me' | 'reopen'

// PATCH /api/tracker/actions/[id] — edit an action or apply a quick transition.
//
// Quick transitions ({ quick: '...' }) are the buttons on each action; they map
// to the agreed state changes (FR-4.x). The assignee may use these on their own
// action even without edit access (the action guard in 082 allows status / due
// date / waiting-since / done-on). Full field edits need edit access.
//
//   done        → status 'done'  (done_on set by the 085 trigger)
//   plus_day    → due_on + 1 day  (or today + 1 if undated)
//   plus_week   → due_on + 7 days (or today + 7 if undated)
//   waiting     → status 'waiting', due_on = today + chaser_days (waiting_since
//                 set by the 085 trigger so "Waiting N days" can be measured)
//   back_to_me  → status 'open'  (waiting_since cleared by the 085 trigger)
//   reopen      → status 'open'  (done_on cleared by the 085 trigger)
//
// All access is enforced by RLS + the action guard (082); a refusal is a clear
// 403 message.
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase, groupId } = ctx
  const actionId = params.id

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  let patch: Record<string, unknown> = {}

  const quick = strOrNull(body.quick) as Quick | null
  if (quick) {
    // Today in the group's time zone (same helper the pages use).
    const { data: todayVal } = await supabase.rpc('tracker_today', { p_group_id: groupId })
    const today = typeof todayVal === 'string' ? todayVal : new Date().toISOString().slice(0, 10)

    switch (quick) {
      case 'done':
        patch = { status: 'done' }
        break
      case 'reopen':
      case 'back_to_me':
        // Clearing done_on / waiting_since is handled by the 085 trigger when
        // the status leaves done / waiting.
        patch = { status: 'open' }
        break
      case 'waiting': {
        const { data: settings } = await supabase
          .from('tracker_settings')
          .select('chaser_days')
          .eq('group_id', groupId)
          .maybeSingle()
        const chaserDays =
          typeof settings?.chaser_days === 'number' ? settings.chaser_days : 5
        patch = { status: 'waiting', due_on: addDays(today, chaserDays) }
        break
      }
      case 'plus_day':
      case 'plus_week': {
        // Advance the current due date; base it on today when there is none.
        const { data: current } = await supabase
          .from('tracker_actions')
          .select('due_on')
          .eq('id', actionId)
          .maybeSingle()
        const base =
          (current?.due_on as string | null) ?? today
        patch = { due_on: addDays(base, quick === 'plus_day' ? 1 : 7) }
        break
      }
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  } else {
    // Full field edit (needs edit access; the DB enforces).
    if ('title' in body) {
      const title = strOrNull(body.title)
      if (!title) return NextResponse.json({ error: 'An action title is required' }, { status: 422 })
      patch.title = title
    }
    if ('type' in body) patch.type = strOrNull(body.type)
    if ('who' in body) patch.who = strOrNull(body.who)
    if ('assignee_id' in body) patch.assignee_id = strOrNull(body.assignee_id)
    if ('due_on' in body) patch.due_on = strOrNull(body.due_on)
    if ('status' in body) {
      const status = strOrNull(body.status)
      patch.status = status === 'waiting' || status === 'done' ? status : 'open'
    }
    if ('priority' in body) patch.priority = strOrNull(body.priority) ?? 'normal'
    if ('milestone_id' in body) patch.milestone_id = strOrNull(body.milestone_id)
    if ('contact_id' in body) patch.contact_id = strOrNull(body.contact_id)
    if ('notes' in body) patch.notes = strOrNull(body.notes)
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  // Read the action's status before the save, so "Last spoke" only moves when
  // the action *becomes* Done (it wasn't Done before this save) — editing the
  // notes of an already-done call must not touch the contact's date.
  const { data: before } = await supabase
    .from('tracker_actions')
    .select('status')
    .eq('id', actionId)
    .maybeSingle()
  const wasDone = (before?.status as string | null) === 'done'

  const { data, error } = await supabase
    .from('tracker_actions')
    .update(patch)
    .eq('id', actionId)
    .select('id, status, type, contact_id')

  if (error) return writeErrorResponse(error)
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "You don't have permission to change this" },
      { status: 403 },
    )
  }

  // "Last spoke": when a call or email action *becomes* Done and has a contact,
  // move that contact's last-contact date to today. Only on the transition into
  // Done — saving an already-done action (e.g. editing its notes) leaves the
  // date alone. Best-effort — if the person can't change the contact (e.g. an
  // assignee without edit access) the update is skipped quietly; the action
  // stays marked Done.
  const updated = data[0] as { status?: string; type?: string | null; contact_id?: string | null }
  if (!wasDone && updated.status === 'done' && updated.contact_id && (updated.type === 'call' || updated.type === 'email')) {
    const { data: todayVal } = await supabase.rpc('tracker_today', { p_group_id: groupId })
    const today = typeof todayVal === 'string' ? todayVal : new Date().toISOString().slice(0, 10)
    await supabase.from('tracker_contacts').update({ last_contact: today }).eq('id', updated.contact_id)
  }

  return NextResponse.json({ data: { id: actionId } })
}

// DELETE /api/tracker/actions/[id] — delete an action.
// RLS restricts this to Managers / Group Owners (082).
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase } = ctx

  const { data, error } = await supabase
    .from('tracker_actions')
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
