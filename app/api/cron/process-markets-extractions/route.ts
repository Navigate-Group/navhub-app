import { NextResponse } from 'next/server'
import { processQueuedChunks } from '@/lib/markets/extract-runner'

export const runtime     = 'nodejs'
export const maxDuration = 300

// ─── GET /api/cron/process-markets-extractions ───────────────────────────────
// Vercel cron (every minute). Drains the Markets document-extraction queue
// (markets_document_chunks). One chunk per invocation keeps each large-PDF
// 20-page range inside its own ≤300 s lambda — mirroring the agents
// process-queued-runs design, but kept separate because Markets is a GLOBAL
// (not group-scoped) area and the agents queue is hard-wired to the agents /
// groups tables.
//
// Race condition guard: processQueuedChunks() flips status queued → running via
// an UPDATE gated on `.eq('status','queued')`, so two concurrent invocations
// cannot double-process a chunk.
export async function GET(request: Request) {
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`
  if (!process.env.CRON_SECRET || request.headers.get('authorization') !== expected) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  try {
    const results = await processQueuedChunks(1)
    return NextResponse.json({ processed: results.length, results })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
