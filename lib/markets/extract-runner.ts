/**
 * Markets Document Extractor — chunk runner & orchestration (MKT-7a).
 * ──────────────────────────────────────────────────────────────────────────
 * Server-side only. Owns the lifecycle of a single extraction unit of work (a
 * "chunk"):
 *
 *   1. download the source file from the private markets-documents bucket;
 *   2. dispatch to the spreadsheet (in-code) or model (PDF/image) extractor,
 *      narrowing to the chunk's page range for large PDFs;
 *   3. stage pending observations / structure into the review queues;
 *   4. log the run to markets_agent_runs (counts, tokens, duration);
 *   5. advance the chunk + document status.
 *
 * Also exposes:
 *   • countPdfPages      — dependency-free page-count heuristic
 *   • enqueueDocument    — create chunk rows for a freshly-uploaded document
 *                          (whole-doc for sheets/images/small PDFs; 20-page
 *                          ranges for large PDFs)
 *
 * A dedicated cron (/api/cron/process-markets-extractions) claims queued chunks
 * race-safely and calls runChunk() — each inside its own ≤300 s lambda.
 */

import { createAdminClient } from '../supabase/admin'
import {
  classifyFile,
  extractSpreadsheet,
  extractWithModel,
  stagePendingObservations,
  stagePendingStructure,
  logExtractionRun,
  PDF_CHUNK_PAGES,
  type ExtractionHints,
  type RefEntry,
  type ChunkExtractionResult,
} from './extract'

const STORAGE_BUCKET = 'markets-documents'

// ── PDF page counting (dependency-free heuristic) ───────────────────────────
// Counts PDF page objects by scanning for `/Type /Page` (not /Pages). Robust
// enough for the chunking decision; exact fidelity is not required because the
// model is told the page range as guidance, and a slightly-off count only
// affects how work is split, never correctness.
export function countPdfPages(buffer: Buffer): number {
  const text = buffer.toString('latin1')
  const matches = text.match(/\/Type\s*\/Page(?![s])/g)
  const n = matches ? matches.length : 0
  return n > 0 ? n : 1
}

// ── Reference-data loader ───────────────────────────────────────────────────

async function loadRefs(): Promise<{ commodities: RefEntry[]; geographies: RefEntry[] }> {
  const admin = createAdminClient()
  const [{ data: c }, { data: g }] = await Promise.all([
    admin.from('markets_commodities').select('id, name').is('archived_at', null),
    admin.from('markets_geo_units').select('id, name').is('archived_at', null),
  ])
  return {
    commodities: (c ?? []) as RefEntry[],
    geographies: (g ?? []) as RefEntry[],
  }
}

// ── Document row shape (subset we read) ─────────────────────────────────────

interface DocRow {
  id: string
  storage_path: string
  mime_type: string | null
  original_filename: string | null
  title: string
  commodities: string[]
  geographies: string[]
  season: string | null
  source_id: string | null
  notes: string | null
  uploaded_by: string | null
  page_count: number | null
}

function hintsFromDoc(doc: DocRow): ExtractionHints {
  return {
    commodities: Array.isArray(doc.commodities) ? doc.commodities : [],
    geographies: Array.isArray(doc.geographies) ? doc.geographies : [],
    season: doc.season,
    sourceId: doc.source_id,
    notes: doc.notes,
  }
}

// ── Enqueue chunks for a freshly-uploaded document ──────────────────────────

/**
 * Create chunk rows for a document and set its status to pending_extraction.
 * Spreadsheets, images and small PDFs get a single whole-document chunk; a PDF
 * with more than PDF_CHUNK_PAGES pages is split into 20-page ranges.
 */
export async function enqueueDocument(documentId: string): Promise<{ chunks: number; pageCount: number | null }> {
  const admin = createAdminClient()
  const { data: doc, error } = await admin
    .from('markets_documents')
    .select('id, storage_path, mime_type, original_filename, title')
    .eq('id', documentId)
    .single()
  if (error || !doc) throw new Error(`[markets] enqueueDocument: document ${documentId} not found`)

  const d = doc as Pick<DocRow, 'id' | 'storage_path' | 'mime_type' | 'original_filename' | 'title'>
  const kind = classifyFile(d.mime_type ?? '', d.original_filename ?? d.title)

  let pageCount: number | null = null
  const chunkRows: Array<{ document_id: string; page_start: number | null; page_end: number | null }> = []

  if (kind === 'pdf') {
    // Need the bytes to count pages.
    const buffer = await downloadFile(d.storage_path)
    pageCount = countPdfPages(buffer)
    if (pageCount > PDF_CHUNK_PAGES) {
      for (let start = 1; start <= pageCount; start += PDF_CHUNK_PAGES) {
        const end = Math.min(start + PDF_CHUNK_PAGES - 1, pageCount)
        chunkRows.push({ document_id: documentId, page_start: start, page_end: end })
      }
    } else {
      chunkRows.push({ document_id: documentId, page_start: null, page_end: null })
    }
  } else {
    chunkRows.push({ document_id: documentId, page_start: null, page_end: null })
  }

  const { error: insErr } = await admin.from('markets_document_chunks').insert(chunkRows)
  if (insErr) throw new Error(`[markets] enqueueDocument: chunk insert failed: ${insErr.message}`)

  await admin
    .from('markets_documents')
    .update({ status: 'pending_extraction', page_count: pageCount, updated_at: new Date().toISOString() })
    .eq('id', documentId)

  return { chunks: chunkRows.length, pageCount }
}

async function downloadFile(path: string): Promise<Buffer> {
  const admin = createAdminClient()
  const { data, error } = await admin.storage.from(STORAGE_BUCKET).download(path)
  if (error || !data) throw new Error(`[markets] download failed for ${path}: ${error?.message ?? 'no data'}`)
  const arrayBuffer = await data.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

// ── Run a single chunk ──────────────────────────────────────────────────────

interface ChunkRow {
  id: string
  document_id: string
  page_start: number | null
  page_end: number | null
  attempts: number
}

/**
 * Execute one extraction chunk end-to-end. Assumes the caller has already
 * claimed the chunk (status queued → running). Advances the chunk + document
 * status, stages pending records, and logs a markets_agent_runs row.
 */
export async function runChunk(chunk: ChunkRow): Promise<{ status: 'done' | 'error'; error?: string }> {
  const admin = createAdminClient()
  const t0 = Date.now()

  // Load the document + reference data.
  const { data: docData, error: docErr } = await admin
    .from('markets_documents')
    .select('id, storage_path, mime_type, original_filename, title, commodities, geographies, season, source_id, notes, uploaded_by, page_count')
    .eq('id', chunk.document_id)
    .single()

  if (docErr || !docData) {
    const msg = `document ${chunk.document_id} not found`
    await failChunk(chunk, msg)
    return { status: 'error', error: msg }
  }
  const doc = docData as DocRow

  // Flip the document to 'extracting' while work is in flight.
  await admin.from('markets_documents')
    .update({ status: 'extracting', updated_at: new Date().toISOString() })
    .eq('id', chunk.document_id)

  const kind = classifyFile(doc.mime_type ?? '', doc.original_filename ?? doc.title)
  if (!kind) {
    const msg = `unsupported file type for document ${chunk.document_id}`
    await failChunk(chunk, msg)
    await finaliseDocument(chunk.document_id)
    return { status: 'error', error: msg }
  }

  try {
    const [buffer, refs] = await Promise.all([downloadFile(doc.storage_path), loadRefs()])
    const hints = hintsFromDoc(doc)
    const pageRange = chunk.page_start != null && chunk.page_end != null
      ? { start: chunk.page_start, end: chunk.page_end }
      : null

    let result: ChunkExtractionResult
    if (kind === 'xlsx' || kind === 'csv') {
      result = await extractSpreadsheet(buffer, kind, hints, refs)
    } else {
      result = await extractWithModel(buffer, kind, hints, refs, pageRange)
    }

    const obsCount = await stagePendingObservations(result.observations, doc.uploaded_by)
    const structCount = await stagePendingStructure(result.structure, doc.id, doc.uploaded_by)

    const unmatched = result.observations.filter(o => o.mapping_status === 'unmatched').length
    const durationMs = Date.now() - t0

    const runStatus: 'success' | 'partial' = unmatched > 0 ? 'partial' : 'success'
    const runId = await logExtractionRun({
      userId: doc.uploaded_by,
      status: runStatus,
      input: {
        document_id: doc.id,
        page_start: chunk.page_start,
        page_end: chunk.page_end,
        hints,
      },
      output: {
        observations: obsCount,
        structure: structCount,
        operators: result.operators,   // stored verbatim (POC — no UI yet)
        unmatched,
      },
      tokensUsed: result.tokensUsed,
      durationMs,
    })

    await admin.from('markets_document_chunks')
      .update({
        status: 'done',
        attempts: chunk.attempts + 1,
        run_id: runId,
        completed_at: new Date().toISOString(),
      })
      .eq('id', chunk.id)

    await finaliseDocument(chunk.document_id)
    return { status: 'done' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await failChunk(chunk, msg)
    await logExtractionRun({
      userId: doc.uploaded_by,
      status: 'error',
      input: { document_id: doc.id, page_start: chunk.page_start, page_end: chunk.page_end },
      output: {},
      tokensUsed: null,
      durationMs: Date.now() - t0,
      errorMessage: msg,
    })
    await finaliseDocument(chunk.document_id)
    return { status: 'error', error: msg }
  }
}

async function failChunk(chunk: ChunkRow, message: string): Promise<void> {
  const admin = createAdminClient()
  await admin.from('markets_document_chunks')
    .update({
      status: 'error',
      attempts: chunk.attempts + 1,
      error_message: message,
      completed_at: new Date().toISOString(),
    })
    .eq('id', chunk.id)
}

/**
 * Recompute the document status from its chunks:
 *   • any chunk still queued/running → leave as 'extracting'
 *   • all done                       → 'extracted'
 *   • none pending and ≥1 error      → 'extraction_failed'
 */
async function finaliseDocument(documentId: string): Promise<void> {
  const admin = createAdminClient()
  const { data: chunks } = await admin
    .from('markets_document_chunks')
    .select('status')
    .eq('document_id', documentId)

  const rows = (chunks ?? []) as Array<{ status: string }>
  const anyPending = rows.some(r => r.status === 'queued' || r.status === 'running')
  if (anyPending) return

  const anyError = rows.some(r => r.status === 'error')
  const next = anyError ? 'extraction_failed' : 'extracted'
  const patch: Record<string, unknown> = { status: next, updated_at: new Date().toISOString() }
  if (anyError) {
    patch.extraction_error = 'One or more extraction chunks failed. See chunk records for detail.'
  }
  await admin.from('markets_documents').update(patch).eq('id', documentId)
}

// ── Claim + process a batch of queued chunks (used by the cron) ─────────────

/**
 * Claim up to `limit` queued chunks race-safely and run each. Returns per-chunk
 * results. The claim UPDATE is gated on `.eq('status','queued')` so concurrent
 * cron invocations cannot double-process a chunk.
 */
export async function processQueuedChunks(limit = 1): Promise<Array<{ chunk_id: string; status: string; error?: string }>> {
  const admin = createAdminClient()
  const { data: queued } = await admin
    .from('markets_document_chunks')
    .select('id, document_id, page_start, page_end, attempts')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(limit)

  const rows = (queued ?? []) as ChunkRow[]
  const results: Array<{ chunk_id: string; status: string; error?: string }> = []

  for (const chunk of rows) {
    // Race-guarded claim.
    const { data: claimed } = await admin
      .from('markets_document_chunks')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', chunk.id)
      .eq('status', 'queued')
      .select('id')
    if (!claimed || claimed.length === 0) {
      results.push({ chunk_id: chunk.id, status: 'skipped' })
      continue
    }

    const res = await runChunk(chunk)
    results.push({ chunk_id: chunk.id, status: res.status, error: res.error })
  }

  return results
}
