'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useDropzone } from 'react-dropzone'
import { FileText, Loader2, UploadCloud, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from './Toaster'

interface RefOption { id: string; name: string }

interface DocRow {
  id: string
  title: string
  original_filename: string | null
  mime_type: string | null
  size_bytes: number | null
  status: string
  commodities: string[] | null
  geographies: string[] | null
  season: string | null
  source_id: string | null
  page_count: number | null
  extraction_error: string | null
  created_at: string
}

interface Props {
  commodities: RefOption[]
  geographies: RefOption[]
  sources: RefOption[]
}

const ACCEPT = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.ms-excel': ['.xls'],
  'text/csv': ['.csv'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
}

const MAX_SIZE = 20 * 1024 * 1024 // dropzone-level cap (largest = PDF 20 MB)

function fmtBytes(n: number | null): string {
  if (!n) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const STATUS_STYLES: Record<string, string> = {
  pending_extraction: 'bg-muted text-muted-foreground',
  extracting:         'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  extracted:          'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  extraction_failed:  'bg-destructive/15 text-destructive',
  // legacy values (migration 072) in case older rows exist
  uploaded:           'bg-muted text-muted-foreground',
  processing:         'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  error:              'bg-destructive/15 text-destructive',
}

function statusLabel(s: string): string {
  return s.replace(/_/g, ' ')
}

export default function DocumentsManager({ commodities, geographies, sources }: Props) {
  const toast = useToast()
  const [commodity, setCommodity] = useState('')
  const [geography, setGeography] = useState('')
  const [season, setSeason] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [notes, setNotes] = useState('')
  const [uploading, setUploading] = useState(false)
  const [rows, setRows] = useState<DocRow[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadList = useCallback(async () => {
    try {
      const res = await fetch('/api/markets/manage/documents')
      const json = await res.json()
      if (res.ok) setRows((json.rows ?? []) as DocRow[])
    } catch {
      /* non-fatal */
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => {
    void loadList()
  }, [loadList])

  // Poll while any document is still processing so status chips self-update.
  useEffect(() => {
    const anyActive = rows.some(r => r.status === 'pending_extraction' || r.status === 'extracting' || r.status === 'processing')
    if (anyActive && !pollRef.current) {
      pollRef.current = setInterval(() => { void loadList() }, 5000)
    } else if (!anyActive && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
  }, [rows, loadList])

  const onDrop = useCallback(async (accepted: File[], rejected: unknown[]) => {
    if (rejected.length) {
      toast.error('That file type or size is not allowed.')
      return
    }
    const file = accepted[0]
    if (!file) return

    setUploading(true)
    const fd = new FormData()
    fd.append('file', file)
    if (commodity) fd.append('commodities', JSON.stringify([commodity]))
    if (geography) fd.append('geographies', JSON.stringify([geography]))
    if (season.trim()) fd.append('season', season.trim())
    if (sourceId) fd.append('source_id', sourceId)
    if (notes.trim()) fd.append('notes', notes.trim())

    try {
      const res = await fetch('/api/markets/manage/documents', { method: 'POST', body: fd })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json.error ?? 'Upload failed.')
      } else {
        toast.success(`Uploaded — queued ${json.chunks ?? 1} extraction ${json.chunks === 1 ? 'task' : 'tasks'}.`)
        setNotes('')
        await loadList()
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error.')
    } finally {
      setUploading(false)
    }
  }, [commodity, geography, season, sourceId, notes, toast, loadList])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPT,
    maxSize: MAX_SIZE,
    multiple: false,
    disabled: uploading,
  })

  return (
    <div className="space-y-6">
      {/* ── Metadata + dropzone ─────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Commodity hint</span>
            <select
              value={commodity}
              onChange={e => setCommodity(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">Any / detect</option>
              {commodities.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Geography hint</span>
            <select
              value={geography}
              onChange={e => setGeography(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">Any / detect</option>
              {geographies.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Season</span>
            <input
              value={season}
              onChange={e => setSeason(e.target.value)}
              placeholder="e.g. 2024"
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>

          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Source</span>
            <select
              value={sourceId}
              onChange={e => setSourceId(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">Unspecified</option>
              {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </div>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Notes</span>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={2}
            placeholder="Anything that helps the extractor — context, caveats, what to focus on…"
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </label>

        <div
          {...getRootProps()}
          className={cn(
            'border-2 border-dashed rounded-lg p-8 text-center transition-colors',
            uploading ? 'cursor-not-allowed opacity-70' : 'cursor-pointer',
            isDragActive ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-accent/40',
          )}
        >
          <input {...getInputProps()} />
          {uploading ? (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="h-9 w-9 animate-spin text-primary" />
              <p className="text-sm font-medium">Uploading…</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <UploadCloud className="h-9 w-9 opacity-40" />
              <p className="text-sm font-medium">
                {isDragActive ? 'Drop it here…' : 'Drag & drop a document, or click to browse'}
              </p>
              <p className="text-xs">PDF (≤20 MB), XLSX / CSV (≤10 MB), PNG / JPEG (≤10 MB)</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Recent uploads ──────────────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Recent uploads</h2>
          <button
            type="button"
            onClick={() => void loadList()}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>

        {loadingList ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
            No documents uploaded yet.
          </p>
        ) : (
          <>
            {/* Table on sm+; stacked cards on mobile */}
            <div className="hidden overflow-x-auto rounded-xl border border-border sm:block">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">File</th>
                    <th className="px-3 py-2 font-medium">Size</th>
                    <th className="px-3 py-2 font-medium">Pages</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Uploaded</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="font-medium">{r.original_filename ?? r.title}</span>
                        </div>
                        {r.extraction_error && (
                          <p className="mt-0.5 text-xs text-destructive">{r.extraction_error}</p>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{fmtBytes(r.size_bytes)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{r.page_count ?? '—'}</td>
                      <td className="px-3 py-2">
                        <span className={cn('inline-block rounded-full px-2 py-0.5 text-xs capitalize', STATUS_STYLES[r.status] ?? 'bg-muted text-muted-foreground')}>
                          {statusLabel(r.status)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {new Date(r.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-2 sm:hidden">
              {rows.map(r => (
                <div key={r.id} className="rounded-xl border border-border bg-card p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate text-sm font-medium">{r.original_filename ?? r.title}</span>
                    </div>
                    <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs capitalize', STATUS_STYLES[r.status] ?? 'bg-muted text-muted-foreground')}>
                      {statusLabel(r.status)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    <span>{fmtBytes(r.size_bytes)}</span>
                    {r.page_count != null && <span>{r.page_count} pages</span>}
                    <span>{new Date(r.created_at).toLocaleDateString()}</span>
                  </div>
                  {r.extraction_error && (
                    <p className="mt-1 text-xs text-destructive">{r.extraction_error}</p>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
