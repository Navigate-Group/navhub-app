import { NextResponse } from 'next/server'
import { getTrackerContext, isEditor, ensureGroupSetup } from '@/lib/tracker/server'
import { readImportBody, prepareImport } from '@/lib/tracker/import-server'

// POST /api/tracker/import/preview — translate an export file and return the
// preview + the editors list for the owner pickers. SAVES NOTHING.
//
// Guards: signed in (401); Manager/Group Owner only (403); the group is set up
// (ensureGroupSetup). A file that isn't an export of the old tracker → 422 with
// the list of problems.
export async function POST(request: Request) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase, userId, groupId } = ctx

  if (!(await isEditor(supabase, groupId))) {
    return NextResponse.json(
      { error: 'Only a Manager or Group Owner can import projects' },
      { status: 403 },
    )
  }

  const setup = await ensureGroupSetup(ctx)
  if (setup.state === 'error') {
    return NextResponse.json({ error: setup.message }, { status: 500 })
  }

  const read = await readImportBody(request)
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status })

  const prepared = await prepareImport(supabase, userId, groupId, read.body)
  if (!prepared.ok) {
    return NextResponse.json(
      { error: prepared.error, problems: prepared.problems ?? [] },
      { status: prepared.status },
    )
  }

  return NextResponse.json({
    data: { preview: prepared.preview, editors: prepared.editors },
  })
}
