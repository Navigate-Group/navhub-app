import { NextResponse } from 'next/server'
import { getTrackerContext } from '@/lib/tracker/server'
import { writeErrorResponse, strOrNull } from '@/lib/tracker/api'

// PATCH /api/tracker/comments/[id] — edit a comment's text.
// Body: { body }
// RLS + the comment guard (082) allow only the author (while they keep comment
// access) to change the text; edited_at is set by the guard.
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

  const text = strOrNull(body.body)
  if (!text) return NextResponse.json({ error: 'A comment needs some text' }, { status: 422 })

  const { data, error } = await supabase
    .from('tracker_comments')
    .update({ body: text })
    .eq('id', params.id)
    .is('deleted_at', null)
    .select('id')

  if (error) return writeErrorResponse(error)
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "You don't have permission to edit this comment" },
      { status: 403 },
    )
  }
  return NextResponse.json({ data: { id: params.id } })
}

// DELETE /api/tracker/comments/[id] — soft-delete a comment (set deleted_at).
// The comment stays in the database as removed, not erased. RLS (082) allows
// the author or a Manager / Group Owner; the guard limits an editor to changing
// only deleted_at on someone else's comment.
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase } = ctx

  const { data, error } = await supabase
    .from('tracker_comments')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', params.id)
    .is('deleted_at', null)
    .select('id')

  if (error) return writeErrorResponse(error)
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "You don't have permission to delete this comment" },
      { status: 403 },
    )
  }
  return NextResponse.json({ ok: true })
}
