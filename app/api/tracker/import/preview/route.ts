import { NextResponse } from 'next/server'
import { getTrackerContext, isEditor, ensureGroupSetup } from '@/lib/tracker/server'
import { readImportRequest, prepareImport } from '@/lib/tracker/import-server'

// POST /api/tracker/import/preview — check an export file from the previous
// tracker and show what importing it would do. Saves nothing.
// Body: { file_name, file (the parsed JSON), owners? { old project id: user id } }
// Managers and Group Owners only.
export async function POST(request: Request) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  if (!(await isEditor(ctx.supabase, ctx.groupId))) {
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
  return NextResponse.json({ data: { preview: prepared.preview, editors: prepared.editors } })
}
