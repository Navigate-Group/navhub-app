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
