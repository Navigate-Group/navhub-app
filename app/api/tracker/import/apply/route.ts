import { NextResponse } from 'next/server'
import { getTrackerContext, isEditor, ensureGroupSetup } from '@/lib/tracker/server'
import { readImportRequest, prepareImport } from '@/lib/tracker/import-server'

// POST /api/tracker/import/apply — import an export file from the previous
// tracker. Same body as the preview. The file is translated again here and
// saved by tracker_import_apply (migration 084) in one transaction, as the
// signed-in user: all of it or none of it. A refused import is recorded as a
// failed import job.
export async function POST(request: Request) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase, groupId, userId } = ctx

  if (!(await isEditor(supabase, groupId))) {
    return NextResponse.json({ error: 'Only a Manager or Group Owner can import projects' }, { status: 403 })
  }
  const setup = await ensureGroupSetup(ctx)
  if (setup.state !== 'ready') {
    return NextResponse.json({ error: 'Projects could not be set up for this group' }, { status: 500 })
  }

  const req = await readImportRequest(request)
  if ('error' in req) return NextResponse.json({ error: req.error }, { status: req.status })

  const prepared = await prepareImport(ctx, req)
  if (!prepared.ok) {
    return NextResponse.json({ error: prepared.errors[0], errors: prepared.errors }, { status: prepared.status })
  }
  if (prepared.preview.errors.length > 0) {
    return NextResponse.json(
      { error: 'Fix the problems in the preview first', errors: prepared.preview.errors },
      { status: 422 },
    )
  }

  const { data, error } = await supabase.rpc('tracker_import_apply', {
    p_group_id: groupId,
    p_file_name: req.fileName,
    p_payload: prepared.payload,
  })

  if (error) {
    // Nothing was saved (one transaction). Keep a record of the attempt.
    await supabase.from('tracker_import_jobs').insert({
      group_id: groupId,
      file_name: req.fileName,
      status: 'failed',
      summary: { error: error.message },
      created_by: userId,
    })
    if (error.code === '42501') {
      return NextResponse.json({ error: error.message || "You don't have permission to import" }, { status: 403 })
    }
    if (error.code === '22023') {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    return NextResponse.json({ error: 'The import could not be saved. Nothing was changed.' }, { status: 500 })
  }

  return NextResponse.json({ data: { summary: data } })
}
