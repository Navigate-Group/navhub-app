import { NextResponse } from 'next/server'
import { getTrackerContext, getGroupPeople } from '@/lib/tracker/server'

// GET /api/tracker/people
// Returns { id, name, role } for the members of the current group. The caller
// is checked as a member through the server client (RLS) before names are read
// with the admin client — the one admin-client exception in the tracker.
export async function GET() {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const people = await getGroupPeople(ctx.supabase, ctx.groupId)
  if (people === null) {
    return NextResponse.json({ error: 'Not a member of this group' }, { status: 403 })
  }
  return NextResponse.json({ data: people })
}
