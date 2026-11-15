/**
 * Markets Document Extractor (MKT-7a) — server-side only.
 * ──────────────────────────────────────────────────────────────────────────
 * Turns an uploaded source document into PENDING observations / structure
 * records for review in a later phase (MKT-7b). Nothing here writes directly to
 * the trusted fact tables — every extracted figure is staged:
 *
 *   • observations → markets_review_queue  (reuses MKT-6 queue; migration 075)
 *   • structure    → markets_structure_queue (migration 076)
 *
 * Strategy by file type:
 *   • XLSX / CSV            → parsed IN CODE here. Column headers are mapped to
 *                            commodity / geography / measure / season / value /
 *                            unit, and each data row becomes a pending
 *                            observation with method 'spreadsheet_extract',
 *                            confidence 'medium'.
 *   • PDF / PNG / JPEG      → sent to the language model as document / image
 *                            blocks; the model returns structured JSON
 *                            (observations + structure + operator mentions).
 *   • Large PDF (>20 pages) → chunked into 20-page ranges upstream; each chunk
 *                            is one model call over its page range.
 *
 * Unmatched commodities / geographies are flagged (mapping_status 'unmatched')
 * with the raw label + a best-guess suggestion, so the reviewer can resolve
 * them in MKT-7b. Operator mentions are captured verbatim under the run's
 * output JSON (POC storage for later use — no UI this phase).
 *
 * ⚠️  Import only in server-side code. Writes use the service-role admin client;
 *     route / cron level role gating authorises the caller.
 */

import { createAdminClient } from '../supabase/admin'
import { queueObservation } from './review'

// ── File constraints (shared by the upload route + client dropzone) ─────────

export const MB = 1024 * 1024

/** Per-mime upload size limits (MKT-7a). */
export const SIZE_LIMITS = {
  pdf:   20 * MB,
  sheet: 10 * MB,  // xlsx / csv
  image: 10 * MB,  // png / jpeg
} as const

/** Accepted upload kinds, keyed by canonical kind. */
export type DocKind = 'pdf' | 'xlsx' | 'csv' | 'png' | 'jpeg'

/** Map a (mime, filename) pair to a canonical DocKind, or null if unsupported. */
export function classifyFile(mime: string, filename: string): DocKind | null {
  const m = (mime || '').toLowerCase()
  const n = (filename || '').toLowerCase()
  if (m === 'application/pdf' || n.endsWith('.pdf')) return 'pdf'
  if (
    m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    m === 'application/vnd.ms-excel' ||
    n.endsWith('.xlsx') || n.endsWith('.xls')
  ) return 'xlsx'
  if (m === 'text/csv' || n.endsWith('.csv')) return 'csv'
  if (m === 'image/png' || n.endsWith('.png')) return 'png'
  if (m === 'image/jpeg' || n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'jpeg'
  return null
}

/** The size limit (bytes) that applies to a given kind. */
export function sizeLimitFor(kind: DocKind): number {
  if (kind === 'pdf') return SIZE_LIMITS.pdf
  if (kind === 'png' || kind === 'jpeg') return SIZE_LIMITS.image
  return SIZE_LIMITS.sheet
}

/** Human-readable accept hint for the dropzone copy. */
export const ACCEPT_HINT = 'PDF (≤20 MB), XLSX/CSV (≤10 MB), PNG/JPEG (≤10 MB)'

// Pages per chunk for large PDFs (MKT-7a).
export const PDF_CHUNK_PAGES = 20

// ── Mapping hints passed from the upload form ───────────────────────────────

export interface ExtractionHints {
  commodities: string[]   // commodity id hints the uploader supplied
  geographies: string[]   // geo id hints
  season:   string | null
  sourceId: string | null
  notes:    string | null
}

// ── Pending-record shapes ───────────────────────────────────────────────────

/** Confidence the extractor assigns to a figure. */
export type Confidence = 'high' | 'medium' | 'low'
/** How a figure was obtained. */
export type ExtractMethod = 'spreadsheet_extract' | 'official' | 'estimate' | 'derived'
/** Whether a label resolved to a known reference id. */
export type MappingStatus = 'matched' | 'unmatched'

/** A proposed observation staged for review. Superset of the observation row. */
export interface PendingObservation {
  geo: string | null
  geo_label: string | null
  commodity: string | null
  commodity_label: string | null
  measure: string | null
  season: string | null
  value: number | null
  unit: string | null
  source: string | null
  confidence: Confidence
  method: ExtractMethod
  note: string | null
  mapping_status: MappingStatus
  suggestions?: { commodity?: string | null; geo?: string | null }
}

/** A proposed farm-structure record staged for review. */
export interface PendingStructure {
  commodity: string | null
  commodity_label: string | null
  geo: string | null
  geo_label: string | null
  area_size: string | null
  turnover: string | null
  ownership: string | null
  breakdowns: unknown[]
  note: string | null
  mapping_status: MappingStatus
}

/** An operator mention captured for later use (no UI this phase). */
export interface OperatorMention {
  name: string
  commodity: string | null
  country: string | null
  role: string | null
  note: string | null
}

/** The structured result of extracting one chunk. */
export interface ChunkExtractionResult {
  observations: PendingObservation[]
  structure: PendingStructure[]
  operators: OperatorMention[]
  tokensUsed: number | null
}

// ── Reference-data matching ─────────────────────────────────────────────────

export interface RefEntry { id: string; name: string }

/** Normalise a label for fuzzy comparison. */
function norm(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Resolve a free-text label to a reference id. Tries: exact id, exact name,
 * then substring both ways. Returns the matched id or a best-guess suggestion.
 */
export function matchRef(
  label: string | null | undefined,
  refs: RefEntry[],
): { id: string | null; suggestion: string | null } {
  if (!label) return { id: null, suggestion: null }
  const l = norm(label)
  if (!l) return { id: null, suggestion: null }

  // Exact id match.
  const byId = refs.find(r => norm(r.id) === l)
  if (byId) return { id: byId.id, suggestion: null }
  // Exact name match.
  const byName = refs.find(r => norm(r.name) === l)
  if (byName) return { id: byName.id, suggestion: null }
  // Substring either direction → treat as a suggestion only (not auto-matched).
  const partial = refs.find(r => {
    const n = norm(r.name)
    return n.includes(l) || l.includes(n)
  })
  return { id: null, suggestion: partial?.id ?? null }
}

// ── Spreadsheet extraction (XLSX / CSV) ─────────────────────────────────────

/** The canonical spreadsheet fields a column header can map to. */
type SheetField = 'commodity' | 'geo' | 'measure' | 'season' | 'value' | 'unit' | 'source'

// Column-header synonyms → canonical field. Lowercased, punctuation-stripped.
const HEADER_MAP: Record<string, SheetField> = {
  commodity: 'commodity', product: 'commodity', crop: 'commodity', good: 'commodity',
  geo: 'geo', geography: 'geo', country: 'geo', region: 'geo', location: 'geo', area: 'geo',
  measure: 'measure', metric: 'measure', indicator: 'measure', variable: 'measure',
  season: 'season', year: 'season', period: 'season',
  value: 'value', amount: 'value', figure: 'value', quantity: 'value', qty: 'value',
  unit: 'unit', units: 'unit', uom: 'unit',
  source: 'source', ref: 'source', reference: 'source', provenance: 'source',
}

/** Classify a header cell to a canonical field, or null. */
function classifyHeader(header: string): SheetField | null {
  const n = norm(header)
  if (HEADER_MAP[n]) return HEADER_MAP[n]
  // substring fallback — "production value", "export country", …
  for (const key of Object.keys(HEADER_MAP)) {
    if (n.includes(key)) return HEADER_MAP[key]
  }
  return null
}

/** Coerce a spreadsheet cell to a finite number, tolerating thousands separators. */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const cleaned = v.replace(/,/g, '').trim()
    if (cleaned !== '' && Number.isFinite(Number(cleaned))) return Number(cleaned)
  }
  return null
}

function cellStr(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s.length ? s : null
}

/**
 * Parse a spreadsheet buffer (XLSX or CSV) into pending observations, in code.
 * Each sheet's first non-empty row is treated as the header; remaining rows
 * become observations. Commodity / geography labels are matched against the
 * reference lists; unmatched labels are flagged with a suggestion.
 */
export async function extractSpreadsheet(
  buffer: Buffer,
  kind: 'xlsx' | 'csv',
  hints: ExtractionHints,
  refs: { commodities: RefEntry[]; geographies: RefEntry[] },
): Promise<ChunkExtractionResult> {
  const XLSX = await import('xlsx')
  const wb = kind === 'csv'
    ? XLSX.read(buffer.toString('utf-8'), { type: 'string' })
    : XLSX.read(buffer, { type: 'buffer' })

  const observations: PendingObservation[] = []

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName]
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, blankrows: false })
    if (rows.length < 2) continue

    // Find the header row: the first row with ≥2 recognised headers.
    let headerIdx = -1
    let colMap: Record<number, ReturnType<typeof classifyHeader>> = {}
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const candidate = rows[i]
      const map: Record<number, ReturnType<typeof classifyHeader>> = {}
      let hits = 0
      candidate.forEach((cell, idx) => {
        const label = cellStr(cell)
        if (!label) return
        const field = classifyHeader(label)
        if (field) { map[idx] = field; hits++ }
      })
      if (hits >= 2) { headerIdx = i; colMap = map; break }
    }
    if (headerIdx === -1) continue

    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r]
      const rec: Partial<Record<'commodity' | 'geo' | 'measure' | 'season' | 'value' | 'unit' | 'source', unknown>> = {}
      for (const [idxStr, field] of Object.entries(colMap)) {
        if (!field) continue
        rec[field] = row[Number(idxStr)]
      }

      const value = toNumber(rec.value)
      if (value === null) continue // skip rows without a numeric value

      const commodityLabel = cellStr(rec.commodity) ?? (hints.commodities[0] ?? null)
      const geoLabel       = cellStr(rec.geo)       ?? (hints.geographies[0] ?? null)

      const cm = matchRef(commodityLabel, refs.commodities)
      const gm = matchRef(geoLabel, refs.geographies)
      const matched = cm.id !== null && gm.id !== null

      observations.push({
        geo: gm.id,
        geo_label: geoLabel,
        commodity: cm.id,
        commodity_label: commodityLabel,
        measure: cellStr(rec.measure),
        season: cellStr(rec.season) ?? hints.season,
        value,
        unit: cellStr(rec.unit),
        source: hints.sourceId,
        confidence: 'medium',
        method: 'spreadsheet_extract',
        note: null,
        mapping_status: matched ? 'matched' : 'unmatched',
        suggestions: matched ? undefined : { commodity: cm.suggestion, geo: gm.suggestion },
      })
    }
  }

  // Spreadsheet parsing is local — no model tokens consumed.
  return { observations, structure: [], operators: [], tokensUsed: 0 }
}

// ── PDF / image extraction (model) ──────────────────────────────────────────

const EXTRACTOR_MODEL = 'claude-haiku-4-5-20251001'

interface AnthropicBlock {
  type: string
  text?: string
  source?: { type: 'base64'; media_type: string; data: string }
}

function buildPrompt(hints: ExtractionHints, pageRange: { start: number; end: number } | null): string {
  const hintLines: string[] = []
  if (hints.commodities.length) hintLines.push(`Commodity hints: ${hints.commodities.join(', ')}`)
  if (hints.geographies.length) hintLines.push(`Geography hints: ${hints.geographies.join(', ')}`)
  if (hints.season)   hintLines.push(`Season hint: ${hints.season}`)
  if (hints.sourceId) hintLines.push(`Source hint: ${hints.sourceId}`)
  if (hints.notes)    hintLines.push(`Uploader notes: ${hints.notes}`)
  const range = pageRange ? ` Consider ONLY pages ${pageRange.start}–${pageRange.end} of the document.` : ''

  return [
    'You are a market-data extraction assistant. Read the attached document/image and extract agricultural / commodity market data as STRICT JSON.' + range,
    hintLines.length ? '\nContext hints (treat as guidance, not ground truth):\n' + hintLines.join('\n') : '',
    '',
    'Return ONLY a JSON object (no prose, no markdown fences) with this shape:',
    `{
  "observations": [
    { "commodity": string|null, "geography": string|null, "measure": string|null,
      "season": string|null, "value": number|null, "unit": string|null,
      "source": string|null, "confidence": "high"|"medium"|"low",
      "method": "official"|"estimate"|"derived", "note": string|null }
  ],
  "structure": [
    { "commodity": string|null, "geography": string|null, "area_size": string|null,
      "turnover": string|null, "ownership": string|null, "breakdowns": [], "note": string|null }
  ],
  "operators": [
    { "name": string, "commodity": string|null, "country": string|null,
      "role": string|null, "note": string|null }
  ]
}`,
    'Use null for anything not present. Only include a value when you can read a number. Do not invent figures.',
  ].filter(Boolean).join('\n')
}

/** Best-effort JSON extraction from a model text response. */
function parseModelJson(text: string): {
  observations?: unknown[]; structure?: unknown[]; operators?: unknown[]
} {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // Try to locate the first {...} block.
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try { return JSON.parse(trimmed.slice(start, end + 1)) } catch { /* fall through */ }
    }
    return {}
  }
}

/**
 * Extract pending records from a PDF or image via the language model. Large
 * PDFs are chunked upstream; `pageRange` narrows the model's attention.
 */
export async function extractWithModel(
  buffer: Buffer,
  kind: 'pdf' | 'png' | 'jpeg',
  hints: ExtractionHints,
  refs: { commodities: RefEntry[]; geographies: RefEntry[] },
  pageRange: { start: number; end: number } | null,
): Promise<ChunkExtractionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured — cannot extract from PDF/image')
  }

  const base64 = buffer.toString('base64')
  const docBlock: AnthropicBlock = kind === 'pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: kind === 'png' ? 'image/png' : 'image/jpeg', data: base64 } }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: EXTRACTOR_MODEL,
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [docBlock, { type: 'text', text: buildPrompt(hints, pageRange) }],
      }],
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`model extraction failed: HTTP ${res.status} ${body.slice(0, 300)}`)
  }

  const json = await res.json() as {
    content: AnthropicBlock[]
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  const text = json.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
  const parsed = parseModelJson(text)
  const tokensUsed = (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0)

  const observations: PendingObservation[] = (Array.isArray(parsed.observations) ? parsed.observations : [])
    .map((o): PendingObservation | null => {
      const obj = o as Record<string, unknown>
      const value = toNumber(obj.value)
      const commodityLabel = cellStr(obj.commodity) ?? (hints.commodities[0] ?? null)
      const geoLabel = cellStr(obj.geography) ?? (hints.geographies[0] ?? null)
      const cm = matchRef(commodityLabel, refs.commodities)
      const gm = matchRef(geoLabel, refs.geographies)
      const matched = cm.id !== null && gm.id !== null
      const confValues: readonly Confidence[] = ['high', 'medium', 'low']
      const conf = confValues.includes(obj.confidence as Confidence)
        ? (obj.confidence as Confidence) : 'low'
      const methodValues: readonly ExtractMethod[] = ['official', 'estimate', 'derived']
      const method = methodValues.includes(obj.method as ExtractMethod)
        ? (obj.method as ExtractMethod) : 'estimate'
      return {
        geo: gm.id,
        geo_label: geoLabel,
        commodity: cm.id,
        commodity_label: commodityLabel,
        measure: cellStr(obj.measure),
        season: cellStr(obj.season) ?? hints.season,
        value,
        unit: cellStr(obj.unit),
        source: cellStr(obj.source) ?? hints.sourceId,
        confidence: conf,
        method,
        note: cellStr(obj.note),
        mapping_status: matched ? 'matched' : 'unmatched',
        suggestions: matched ? undefined : { commodity: cm.suggestion, geo: gm.suggestion },
      }
    })
    .filter((o): o is PendingObservation => o !== null)

  const structure: PendingStructure[] = (Array.isArray(parsed.structure) ? parsed.structure : [])
    .map((s): PendingStructure => {
      const obj = s as Record<string, unknown>
      const commodityLabel = cellStr(obj.commodity) ?? (hints.commodities[0] ?? null)
      const geoLabel = cellStr(obj.geography) ?? (hints.geographies[0] ?? null)
      const cm = matchRef(commodityLabel, refs.commodities)
      const gm = matchRef(geoLabel, refs.geographies)
      return {
        commodity: cm.id,
        commodity_label: commodityLabel,
        geo: gm.id,
        geo_label: geoLabel,
        area_size: cellStr(obj.area_size),
        turnover: cellStr(obj.turnover),
        ownership: cellStr(obj.ownership),
        breakdowns: Array.isArray(obj.breakdowns) ? obj.breakdowns : [],
        note: cellStr(obj.note),
        mapping_status: cm.id && gm.id ? 'matched' : 'unmatched',
      }
    })

  const operators: OperatorMention[] = (Array.isArray(parsed.operators) ? parsed.operators : [])
    .map((o): OperatorMention | null => {
      const obj = o as Record<string, unknown>
      const name = cellStr(obj.name)
      if (!name) return null
      return {
        name,
        commodity: cellStr(obj.commodity),
        country: cellStr(obj.country),
        role: cellStr(obj.role),
        note: cellStr(obj.note),
      }
    })
    .filter((o): o is OperatorMention => o !== null)

  return { observations, structure, operators, tokensUsed }
}

// ── Staging pending records ─────────────────────────────────────────────────

/** Stage extracted observations into the review queue. Returns the count. */
export async function stagePendingObservations(
  obs: PendingObservation[],
  submittedBy: string | null,
): Promise<number> {
  let n = 0
  for (const o of obs) {
    await queueObservation({
      payload: { ...o } as Record<string, unknown>,
      submittedBy,
      commodity: o.commodity,
      source: o.source,
    })
    n++
  }
  return n
}

/** Stage extracted structure records into the structure queue. Returns the count. */
export async function stagePendingStructure(
  rows: PendingStructure[],
  documentId: string,
  submittedBy: string | null,
): Promise<number> {
  if (rows.length === 0) return 0
  const admin = createAdminClient()
  const payloads = rows.map(r => ({
    payload: { ...r } as Record<string, unknown>,
    commodity: r.commodity,
    geo: r.geo,
    document_id: documentId,
    status: 'pending' as const,
    submitted_by: submittedBy,
  }))
  const { error } = await admin.from('markets_structure_queue').insert(payloads)
  if (error) throw new Error(`[markets] structure-queue insert failed: ${error.message}`)
  return rows.length
}

// ── Run logging (markets_agent_runs) ────────────────────────────────────────

export interface LogRunInput {
  userId: string | null
  status: 'success' | 'partial' | 'error'
  input: Record<string, unknown>
  output: Record<string, unknown>
  tokensUsed: number | null
  durationMs: number
  errorMessage?: string | null
}

/**
 * Append a Document Extractor run to markets_agent_runs. Returns the run id.
 * Never throws — logging failures are swallowed so they cannot fail an
 * otherwise-successful extraction (the error is logged to the console).
 */
export async function logExtractionRun(input: LogRunInput): Promise<string | null> {
  try {
    const admin = createAdminClient()
    const { data, error } = await admin
      .from('markets_agent_runs')
      .insert({
        user_id: input.userId,
        type: 'document_extractor',
        status: input.status,
        input: input.input,
        output: input.output,
        tokens_used: input.tokensUsed,
        duration_ms: input.durationMs,
        tags: ['Markets'],
        error_message: input.errorMessage ?? null,
      })
      .select('id')
      .single()
    if (error) {
      console.error('[markets] logExtractionRun failed:', error.message)
      return null
    }
    return (data as { id: string }).id
  } catch (err) {
    console.error('[markets] logExtractionRun threw:', err instanceof Error ? err.message : String(err))
    return null
  }
}
