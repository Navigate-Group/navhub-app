import { handleApply } from '@/lib/tracker/import-server'

// POST /api/tracker/import/apply — translate the file again, refuse with 422 if
// there are problems, then apply everything in one transaction via
// tracker_import_apply(). On a database error, a `failed` job is recorded and
// the error returned. Editor-only (enforced by the database). See
// lib/tracker/import-server.ts.
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return handleApply(request)
}
