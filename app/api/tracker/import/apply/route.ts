import { NextResponse } from 'next/server'
import type { PostgrestError } from '@supabase/supabase-js'
import { getTrackerContext, isEditor, ensureGroupSetup } from '@/lib/tracker/server'
import { readImportBody, prepareImport } from '@/lib/tracker/import-server'

// POST /api/tracker/import/apply — translate again and persist everything in one
// atomic transaction via tracker_import_apply (migration 084). SAVES.
//
// Guards: signed in (401); Manager/Group Owner only (403); the group is set up.
// If the preview still has errors → 422 with the list. On a database refusal,
// record a `failed` tracker_import_jobs row and map the code to a status.
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

  // The preview is the source of truth for problems: don't save a file with any.
  if (prepared.preview.errors.length > 0) {
    return NextResponse.json(
      { error: 'Fix the problems in the preview first', problems: prepared.preview.errors },
      { status: 422 },
    )
  }

  const fileName = read.body.file_name
  const { data, error } = await supabase.rpc('tracker_import_apply', {
    p_group_id: groupId,
    p_file_name: fileName,
    p_payload: prepared.payload,
  })

  if (error) {
    // Record the failed attempt (nothing was saved by the rolled-back function).
    await supabase.from('tracker_import_jobs').insert({
      group_id: groupId,
      file_name: fileName,
      status: 'failed',
      summary: { error: error.message },
      created_by: userId,
    })

    const code = (error as PostgrestError).code
    if (code === '42501') {
      return NextResponse.json(
        { error: 'Only a Manager or Group Owner can import projects' },
        { status: 403 },
      )
    }
    if (code === '22023') {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    return NextResponse.json(
      { error: 'The import could not be saved. Nothing was changed.' },
      { status: 500 },
    )
  }

  return NextResponse.json({ data: { summary: data } })
}
