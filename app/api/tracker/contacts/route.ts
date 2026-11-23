import { NextResponse } from 'next/server'
import { getTrackerContext } from '@/lib/tracker/server'
import { writeErrorResponse, strOrNull } from '@/lib/tracker/api'

// POST /api/tracker/contacts — add a contact to a project.
// Either link an existing contact ({ plan_id, contact_id }) or create a new one
// and link it ({ plan_id, name, org?, role?, phone?, email?, notes? }).
// RLS (082) requires edit access on the plan (to link) and add-contact rights
// (editor, or a member with edit access on a plan) to create.
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

  const planId = strOrNull(body.plan_id)
  if (!planId) return NextResponse.json({ error: 'plan_id is required' }, { status: 422 })

  let contactId = strOrNull(body.contact_id)

  // Create a new contact when no existing one was chosen.
  if (!contactId) {
    const name = strOrNull(body.name)
    if (!name) return NextResponse.json({ error: 'A contact name is required' }, { status: 422 })

    const { data: created, error: createErr } = await supabase
      .from('tracker_contacts')
      .insert({
        group_id: groupId,
        name,
        org: strOrNull(body.org),
        role: strOrNull(body.role),
        phone: strOrNull(body.phone),
        email: strOrNull(body.email),
        notes: strOrNull(body.notes),
      })
      .select('id')
      .single()

    if (createErr) return writeErrorResponse(createErr)
    contactId = created.id as string
  }

  // Link the contact to the plan (idempotent).
  const { error: linkErr } = await supabase
    .from('tracker_contact_plans')
    .upsert({ contact_id: contactId, plan_id: planId, group_id: groupId }, { onConflict: 'contact_id,plan_id' })

  if (linkErr) return writeErrorResponse(linkErr)
  return NextResponse.json({ data: { id: contactId } }, { status: 201 })
}

// DELETE /api/tracker/contacts — unlink a contact from a project (keeps the
// contact). Body: { plan_id, contact_id }. RLS requires edit access on the plan.
export async function DELETE(request: Request) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase } = ctx

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const planId = strOrNull(body.plan_id)
  const contactId = strOrNull(body.contact_id)
  if (!planId) return NextResponse.json({ error: 'plan_id is required' }, { status: 422 })
  if (!contactId) return NextResponse.json({ error: 'contact_id is required' }, { status: 422 })

  const { data, error } = await supabase
    .from('tracker_contact_plans')
    .delete()
    .eq('plan_id', planId)
    .eq('contact_id', contactId)
    .select('contact_id')

  if (error) return writeErrorResponse(error)
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "You don't have permission to change this project's contacts" },
      { status: 403 },
    )
  }
  return NextResponse.json({ ok: true })
}
