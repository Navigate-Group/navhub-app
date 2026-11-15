'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Loader2, RefreshCw, Check, X, Pencil, ChevronDown, ChevronRight,
  CheckCircle2, AlertTriangle, Search, FileText,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from './Toaster'
import EditObservationModal from './EditObservationModal'

// ── Shared types (mirror lib/markets/review-queue EnrichedEntry) ──────────────

export interface RefOption { id: string; name: string }

export interface PendingPayloadView {
  geo: string | null
  geo_label: string | null
  commodity: string | null
  commodity_label: string | null
  measure: string | null
  season: string | null
  value: number | null
  unit: string | null
  source: string | null
  confidence: string | null
  method: string | null
  note: string | null
  mapping_status: 'matched' | 'unmatched'
  suggestions?: { commodity?: string | null; geo?: string | null }
  document_id?: string | null
  document_name?: string | null
}

export interface ComparisonView {
  live: { value: number; unit: string | null; confidence: string | null } | null
  percentDiff: number | null
  largeDiff: boolean
  confidenceMismatch: boolean
}

export interface EntryView {
  id: string
  status: 'pending' | 'approved' | 'rejected'
  submitter_email: string | null
  review_note: string | null
  created_at: string
  reviewed_at: string | null
  payload: PendingPayloadView
  comparison: ComparisonView
}

interface QueueResponse {
  entries: EntryView[]
  counts: { pending: number; approved: number; rejected: number }
  page: number
  pageSize: number
  total: number
}

type Tab = 'all' | 'pending' | 'approved' | 'rejected'

interface Props {
  commodities: RefOption[]
  geographies: RefOption[]
  sources: RefOption[]
}

function fmtNum(n: number | null): string {
  if (n === null) return '—'
  return new Intl.NumberFormat('en-AU', { maximumFractionDigits: 2 }).format(n)
}

const CONF_STYLES: Record<string, string> = {
  high:   'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  medium: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  low:    'bg-destructive/15 text-destructive',
}

export default function ReviewQueueManager({ commodities, geographies, sources }: Props) {
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('pending')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<QueueResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<EntryView | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search.trim()); setPage(1) }, 300)
    return () => clearTimeout(t)
  }, [search])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ status: tab, page: String(page), pageSize: '50' })
      if (debounced) params.set('search', debounced)
      const res = await fetch(`/api/markets/manage/review?${params.toString()}`)
      const json = await res.json()
      if (res.ok) {
        setData(json as QueueResponse)
      } else {
        toast.error(json.error ?? 'Failed to load the review queue.')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error.')
    } finally {
      setLoading(false)
    }
  }, [tab, page, debounced, toast])

  useEffect(() => { void load() }, [load])

  const entries = data?.entries ?? []
  const counts = data?.counts ?? { pending: 0, approved: 0, rejected: 0 }
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  // Group entries by originating document for the expandable dashboard view.
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; rows: EntryView[] }>()
    for (const e of entries) {
      const key = e.payload.document_id ?? '__none__'
      const name = e.payload.document_name ?? 'Template import / manual'
      if (!map.has(key)) map.set(key, { name, rows: [] })
      map.get(key)!.rows.push(e)
    }
    return Array.from(map.entries()).map(([id, g]) => ({ id, ...g }))
  }, [entries])

  // Expand all groups by default when a new page loads.
  useEffect(() => {
    setExpanded(new Set(groups.map(g => g.id)))
    setSelected(new Set())
  }, [groups])

  const pendingIds = useMemo(
    () => entries.filter(e => e.status === 'pending').map(e => e.id),
    [entries],
  )

  const toggleSelect = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  const selectAllPending = useCallback(() => {
    setSelected(prev => (prev.size === pendingIds.length ? new Set() : new Set(pendingIds)))
  }, [pendingIds])

  // ── Actions ────────────────────────────────────────────────────────────────

  const approve = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return
    setBusy(true)
    const toastId = ids.length > 1 ? `Approving ${ids.length} observations…` : 'Approving…'
    toast.success(toastId)
    try {
      const res = await fetch('/api/markets/manage/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', ids }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json.error ?? 'Approval failed.')
      } else if (json.failed > 0) {
        toast.error(`${json.approved} approved, ${json.failed} failed — check unmapped rows.`)
      } else {
        toast.success(`Approved ${json.approved} observation${json.approved === 1 ? '' : 's'} into the live dataset.`)
      }
      setSelected(new Set())
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error.')
    } finally {
      setBusy(false)
    }
  }, [toast, load])

  const reject = useCallback(async (id: string) => {
    const reason = window.prompt('Reason for rejecting (optional):') ?? null
    setBusy(true)
    try {
      const res = await fetch('/api/markets/manage/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject', id, reason }),
      })
      const json = await res.json()
      if (!res.ok) toast.error(json.error ?? 'Reject failed.')
      else { toast.success('Rejected.'); await load() }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error.')
    } finally {
      setBusy(false)
    }
  }, [toast, load])

  // ── Keyboard shortcuts: a / r / e on the active row ─────────────────────────
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (editing) return
      const target = ev.target as HTMLElement
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (!activeId) return
      const entry = entries.find(e => e.id === activeId)
      if (!entry || entry.status !== 'pending') return
      if (ev.key === 'a') { ev.preventDefault(); void approve([activeId]) }
      else if (ev.key === 'r') { ev.preventDefault(); void reject(activeId) }
      else if (ev.key === 'e') { ev.preventDefault(); setEditing(entry) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeId, entries, editing, approve, reject])

  const TABS: Array<{ key: Tab; label: string; count?: number }> = [
    { key: 'all', label: 'All' },
    { key: 'pending', label: 'Pending', count: counts.pending },
    { key: 'approved', label: 'Approved', count: counts.approved },
    { key: 'rejected', label: 'Rejected', count: counts.rejected },
  ]

  return (
    <div className="space-y-4">
      {/* ── Summary counts ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3">
        <SummaryCard label="Pending" value={counts.pending} tone="amber" />
        <SummaryCard label="Approved" value={counts.approved} tone="emerald" />
        <SummaryCard label="Rejected" value={counts.rejected} tone="muted" />
      </div>

      {/* ── Filter tabs + search ────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1" role="tablist">
          {TABS.map(t => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => { setTab(t.key); setPage(1) }}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                tab === t.key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
              {typeof t.count === 'number' && (
                <span className="ml-1.5 text-xs text-muted-foreground">{t.count}</span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search commodity, geo, file…"
              className="w-full rounded-md border border-input bg-background py-1.5 pl-8 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring sm:w-64"
            />
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            aria-label="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ── Bulk action bar ─────────────────────────────────────────────── */}
      {pendingIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.size > 0 && selected.size === pendingIds.length}
              onChange={selectAllPending}
              className="h-4 w-4 rounded border-input"
            />
            Select all pending
          </label>
          <span className="text-sm text-muted-foreground">{selected.size} selected</span>
          <button
            type="button"
            disabled={busy || selected.size === 0}
            onClick={() => void approve(Array.from(selected))}
            className="ml-auto flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Approve selected
          </button>
        </div>
      )}

      {/* ── Queue ───────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          Nothing in this view.
        </p>
      ) : (
        <div className="space-y-3">
          {groups.map(group => {
            const open = expanded.has(group.id)
            return (
              <div key={group.id} className="overflow-hidden rounded-xl border border-border">
                <button
                  type="button"
                  onClick={() => setExpanded(prev => {
                    const next = new Set(prev)
                    if (next.has(group.id)) next.delete(group.id); else next.add(group.id)
                    return next
                  })}
                  className="flex w-full items-center gap-2 bg-muted/50 px-3 py-2 text-left text-sm font-medium hover:bg-muted"
                >
                  {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate">{group.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{group.rows.length} row{group.rows.length === 1 ? '' : 's'}</span>
                </button>

                {open && (
                  <div className="divide-y divide-border">
                    {group.rows.map(entry => (
                      <ReviewRow
                        key={entry.id}
                        entry={entry}
                        selected={selected.has(entry.id)}
                        active={activeId === entry.id}
                        busy={busy}
                        onSelect={() => toggleSelect(entry.id)}
                        onFocusRow={() => setActiveId(entry.id)}
                        onApprove={() => void approve([entry.id])}
                        onReject={() => void reject(entry.id)}
                        onEdit={() => setEditing(entry)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Pagination ──────────────────────────────────────────────────── */}
      {data && totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Page {data.page} of {totalPages} · {data.total} rows
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              className="rounded-md border border-border px-3 py-1 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage(p => p + 1)}
              className="rounded-md border border-border px-3 py-1 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Tip: click a row to focus it, then press <kbd className="rounded border border-border px-1">a</kbd> to approve,
        {' '}<kbd className="rounded border border-border px-1">r</kbd> to reject,
        {' '}<kbd className="rounded border border-border px-1">e</kbd> to edit.
      </p>

      {editing && (
        <EditObservationModal
          entry={editing}
          commodities={commodities}
          geographies={geographies}
          sources={sources}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load() }}
          onApproved={async () => { setEditing(null); await load() }}
        />
      )}
    </div>
  )
}

// ── Summary card ──────────────────────────────────────────────────────────────

function SummaryCard({ label, value, tone }: { label: string; value: number; tone: 'amber' | 'emerald' | 'muted' }) {
  const toneClass =
    tone === 'amber' ? 'text-amber-600 dark:text-amber-400'
    : tone === 'emerald' ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-muted-foreground'
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('text-2xl font-bold', toneClass)}>{value}</p>
    </div>
  )
}

// ── Review row ────────────────────────────────────────────────────────────────

function ReviewRow({
  entry, selected, active, busy, onSelect, onFocusRow, onApprove, onReject, onEdit,
}: {
  entry: EntryView
  selected: boolean
  active: boolean
  busy: boolean
  onSelect: () => void
  onFocusRow: () => void
  onApprove: () => void
  onReject: () => void
  onEdit: () => void
}) {
  const p = entry.payload
  const c = entry.comparison
  const isPending = entry.status === 'pending'

  return (
    <div
      onClick={onFocusRow}
      className={cn(
        'px-3 py-2.5 transition-colors',
        active ? 'bg-accent/50' : 'hover:bg-accent/30',
      )}
    >
      <div className="flex items-start gap-3">
        {isPending && (
          <input
            type="checkbox"
            checked={selected}
            onClick={e => e.stopPropagation()}
            onChange={onSelect}
            className="mt-1 h-4 w-4 shrink-0 rounded border-input"
          />
        )}

        <div className="min-w-0 flex-1">
          {/* Line 1: commodity · geo · measure · season + mapping status */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-medium">{p.commodity_label ?? p.commodity ?? '—'}</span>
            <span className="text-muted-foreground">·</span>
            <span>{p.geo_label ?? p.geo ?? '—'}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">{p.measure ?? '—'}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">{p.season ?? '—'}</span>
            {p.mapping_status === 'matched' ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-3 w-3" /> matched
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3" /> unmatched
              </span>
            )}
          </div>

          {/* Line 2: value + unit + confidence + method + source + live diff */}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="font-mono text-foreground">{fmtNum(p.value)}{p.unit ? ` ${p.unit}` : ''}</span>
            {p.confidence && (
              <span className={cn('rounded-full px-1.5 py-0.5', CONF_STYLES[p.confidence] ?? 'bg-muted')}>
                {p.confidence}
              </span>
            )}
            {p.method && <span>{p.method}</span>}
            {p.source && <span>src: {p.source}</span>}

            {c.live && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded px-1.5 py-0.5',
                  c.largeDiff || c.confidenceMismatch
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-muted',
                )}
                title="Current live figure for this key"
              >
                live {fmtNum(c.live.value)}{c.live.unit ? ` ${c.live.unit}` : ''}
                {c.percentDiff !== null && <> ({c.percentDiff.toFixed(0)}%)</>}
                {(c.largeDiff || c.confidenceMismatch) && <AlertTriangle className="h-3 w-3" />}
              </span>
            )}
          </div>

          {entry.review_note && (
            <p className="mt-1 text-xs italic text-muted-foreground">Note: {entry.review_note}</p>
          )}
        </div>

        {/* Actions */}
        {isPending ? (
          <div className="flex shrink-0 items-center gap-1" onClick={e => e.stopPropagation()}>
            <button
              type="button" onClick={onEdit} disabled={busy}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              aria-label="Edit"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button" onClick={onReject} disabled={busy}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
              aria-label="Reject"
            >
              <X className="h-4 w-4" />
            </button>
            <button
              type="button" onClick={onApprove} disabled={busy}
              className="rounded-md p-1.5 text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400 disabled:opacity-50"
              aria-label="Approve"
            >
              <Check className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <span className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-xs capitalize',
            entry.status === 'approved'
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
              : 'bg-destructive/15 text-destructive',
          )}>
            {entry.status}
          </span>
        )}
      </div>
    </div>
  )
}
