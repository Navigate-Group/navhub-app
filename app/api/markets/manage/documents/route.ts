import { NextResponse } from 'next/server'
import { requireManager } from '../_auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { classifyFile, sizeLimitFor, SIZE_LIMITS } from '@/lib/markets/extract'
import { enqueueDocument } from '@/lib/markets/extract-runner'

export const runtime = 'nodejs'
export const maxDuration = 60

const STORAGE_BUCKET = 'markets-documents'

/**
 * Markets document upload & extraction API (MKT-7a). Manager+ only (enforced by
 * middleware on /api/markets/manage/* and re-checked here for defence-in-depth +
 * to obtain the uploader id).
 *
 *   GET   ?status=…  → list documents (newest first) with chunk/run summary
 *   POST  multipart  → upload a file + metadata, store it privately, record the
 *                      markets_documents row, enqueue extraction chunks, and
 *                      kick off a best-effort immediate extraction.
 */
export async function GET(req: Request) {
  const ctx = await requireManager()
  if (ctx.error) return ctx.error
  const admin = createAdminClient()
  const sp = new URL(req.url).searchParams
  const status = sp.get('status')

  let q = admin
    .from('markets_documents')
    .select('id, title, original_filename, mime_type, size_bytes, status, commodities, geographies, season, source_id, notes, page_count, extraction_error, uploaded_by, created_at, updated_at')
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(100)
  if (status) q = q.eq('status', status)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rows: data ?? [] })
}

export async function POST(req: Request) {
  const ctx = await requireManager()
  if (ctx.error) return ctx.error

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }

  const file = form.get('file') as File | null
  if (!file) {
    return NextResponse.json({ error: 'A file is required.' }, { status: 400 })
  }

  // ── Validate type + size ──────────────────────────────────────────────────
  const kind = classifyFile(file.type, file.name)
  if (!kind) {
    return NextResponse.json(
      { error: 'Unsupported file type. Allowed: PDF, XLSX, CSV, PNG, JPEG.' },
      { status: 400 },
    )
  }
  const limit = sizeLimitFor(kind)
  if (file.size > limit) {
    const mb = Math.round(limit / (1024 * 1024))
    return NextResponse.json(
      { error: `File exceeds the ${mb} MB limit for ${kind.toUpperCase()}.` },
      { status: 400 },
    )
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'File is empty.' }, { status: 400 })
  }

  // ── Metadata ──────────────────────────────────────────────────────────────
  const parseList = (raw: FormDataEntryValue | null): string[] => {
    if (typeof raw !== 'string' || !raw.trim()) return []
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim())
    } catch {
      // comma-separated fallback
      return raw.split(',').map(s => s.trim()).filter(Boolean)
    }
    return []
  }
  const trimOrNull = (raw: FormDataEntryValue | null): string | null => {
    if (typeof raw !== 'string') return null
    const t = raw.trim()
    return t.length ? t : null
  }

  const commodities = parseList(form.get('commodities'))
  const geographies = parseList(form.get('geographies'))
  const season   = trimOrNull(form.get('season'))
  const sourceId = trimOrNull(form.get('source_id'))
  const notes    = trimOrNull(form.get('notes'))
  const title    = trimOrNull(form.get('title')) ?? file.name

  const admin = createAdminClient()

  // ── Store the file privately ──────────────────────────────────────────────
  const ts = Date.now()
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '_')
  const storagePath = `${ctx.userId}/${ts}_${safeName}`
  const bytes = Buffer.from(await file.arrayBuffer())

  const { error: storageErr } = await admin.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, bytes, { contentType: file.type || 'application/octet-stream', upsert: false })
  if (storageErr) {
    return NextResponse.json({ error: `Storage error: ${storageErr.message}` }, { status: 500 })
  }

  // ── Record the document row ───────────────────────────────────────────────
  const { data: doc, error: insErr } = await admin
    .from('markets_documents')
    .insert({
      title,
      original_filename: file.name,
      storage_path: storagePath,
      mime_type: file.type || null,
      size_bytes: file.size,
      commodities,
      geographies,
      season,
      source_id: sourceId,
      notes,
      // single-commodity hint back-fills the legacy 072 column where possible
      commodity: commodities.length === 1 ? commodities[0] : null,
      status: 'pending_extraction',
      uploaded_by: ctx.userId,
    })
    .select('id')
    .single()

  if (insErr || !doc) {
    // Roll back the stored file so we don't orphan it.
    await admin.storage.from(STORAGE_BUCKET).remove([storagePath])
    return NextResponse.json({ error: insErr?.message ?? 'Failed to record document' }, { status: 500 })
  }

  const documentId = (doc as { id: string }).id

  // ── Enqueue extraction chunks ─────────────────────────────────────────────
  let chunks = 0
  try {
    const q = await enqueueDocument(documentId)
    chunks = q.chunks
  } catch (err) {
    await admin
      .from('markets_documents')
      .update({ status: 'extraction_failed', extraction_error: err instanceof Error ? err.message : String(err) })
      .eq('id', documentId)
    return NextResponse.json(
      { error: 'Uploaded, but failed to queue extraction.', document_id: documentId },
      { status: 500 },
    )
  }

  // Best-effort immediate processing of one chunk so small docs feel instant;
  // remaining chunks (large PDFs) are drained by the cron. We never block the
  // response on the full run — fire-and-forget, cron is the source of truth.
  void (async () => {
    try {
      const { processQueuedChunks } = await import('@/lib/markets/extract-runner')
      await processQueuedChunks(1)
    } catch (err) {
      console.error('[markets] immediate extraction failed:', err instanceof Error ? err.message : String(err))
    }
  })()

  return NextResponse.json(
    {
      document_id: documentId,
      chunks,
      limits: {
        pdf: SIZE_LIMITS.pdf,
        sheet: SIZE_LIMITS.sheet,
        image: SIZE_LIMITS.image,
      },
    },
    { status: 201 },
  )
}
