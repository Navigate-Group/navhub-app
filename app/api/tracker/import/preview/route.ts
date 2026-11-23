import { handlePreview } from '@/lib/tracker/import-server'

// POST /api/tracker/import/preview — read the uploaded file and return a
// preview (counts, per-project rows with owner pickers, problems, notes,
// regions) plus the group's editors. Saves nothing. Editor-only (enforced by
// the database as the signed-in user). See lib/tracker/import-server.ts.
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return handlePreview(request)
}
