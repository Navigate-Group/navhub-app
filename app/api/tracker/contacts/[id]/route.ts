import { NextResponse } from 'next/server'
import { getTrackerContext } from '@/lib/tracker/server'
import { writeErrorResponse, strOrNull } from '@/lib/tracker/api'

// PATCH /api/tracker/contacts/[id] — edit a contact's details.
// Body: { name?, org?, role?, phone?, email?, notes? }
// RLS (082) allows an editor, or a member with edit access on a plan the
// contact is linked to, to change it.
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase } = ctx

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}
  // { archive: true } archives (hides from lists but keeps history);
  // { archive: false } restores. Managers / Group Owners only — the database
  // refuses others, surfaced as a clear 403.
  if (typeof body.archive === 'boolean') {
    patch.archived_at = body.archive ? new Date().toISOString() : null
  }
  if ('name' in body) {
    const name = strOrNull(body.name)
    if (!name) return NextResponse.json({ error: 'A contact name is required' }, { status: 422 })
    patch.name = name
  }
  if ('org' in body) patch.org = strOrNull(body.org)
  if ('role' in body) patch.role = strOrNull(body.role)
  if ('phone' in body) patch.phone = strOrNull(body.phone)
  if ('email' in body) patch.email = strOrNull(body.email)
  if ('notes' in body) patch.notes = strOrNull(body.notes)
  // last_contact: a 'YYYY-MM-DD' date, or null to clear. The People page's
  // "Contacted today" sets this to today's date in the group's time zone.
  if ('last_contact' in body) patch.last_contact = strOrNull(body.last_contact)

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('tracker_contacts')
    .update(patch)
    .eq('id', params.id)
    .select('id')

  if (error) return writeErrorResponse(error)
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "You don't have permission to edit this contact" },
      { status: 403 },
    )
  }
  return NextResponse.json({ data: { id: params.id } })
}
