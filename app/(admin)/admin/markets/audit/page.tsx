'use client'

import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import MarketsAdminNav from '@/components/admin/markets/MarketsAdminNav'

/**
 * Admin → Markets → Audit (MKT-8). Super-admin only. Queries the immutable
 * markets_audit log — the trail observation approvals, supersedes (recorded as
 * an 'archive' with a note) and markets_documents changes write to. Filterable
 * by user (actor), date range, target table and action.
 */

interface AuditEntry {
  id: string
  actor_id: string | null
  actor_email: string | null
  action: string
  target_table: string
  row_id: string
  old_value: Record<string, unknown> | null
  new_value: Record<string, unknown> | null
  note: string | null
  created_at: string
}

interface Pagination {
  page: number
  limit: number
  total: number
  pages: number
}

// The real markets_audit action vocabulary (migration 075 CHECK). A supersede is
// recorded as an 'archive' of the prior row (with a note) plus an 'insert'.
const ACTIONS = ['insert', 'update', 'archive', 'restore', 'delete']

const ACTION_COLOUR: Record<string, string> = {
  insert:  'bg-green-900/50 text-green-300',
  update:  'bg-blue-900/50 text-blue-300',
  archive: 'bg-amber-900/50 text-amber-300',
  restore: 'bg-teal-900/50 text-teal-300',
  delete:  'bg-red-900/50 text-red-300',
}

// Common target tables for the filter dropdown.
const TABLES = [
  'markets_observations',
  'markets_documents',
  'markets_review_queue',
  'markets_sources',
  'markets_commodities',
  'markets_geo_units',
  'markets_prices',
  'markets_fx',
  'markets_structure',
  'markets_operators',
]

function fmtDate(s: string) {
  return new Date(s).toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export default function MarketsAuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [paging, setPaging]   = useState<Pagination>({ page: 1, limit: 50, total: 0, pages: 1 })
  const [page, setPage]       = useState(1)
  const [loading, setLoading] = useState(true)
  const [action, setAction]   = useState('')
  const [table, setTable]     = useState('')
  const [actor, setActor]     = useState('')
  const [from, setFrom]       = useState('')
  const [to, setTo]           = useState('')

  function load() {
    setLoading(true)
    const sp = new URLSearchParams({ page: String(page), limit: '50' })
    if (action) sp.set('action', action)
    if (table)  sp.set('target_table', table)
    if (actor.trim())  sp.set('actor_id', actor.trim())
    if (from)   sp.set('from', from)
    if (to)     sp.set('to', to)
    fetch(`/api/admin/markets/audit?${sp.toString()}`)
      .then(r => r.json())
      .then(json => {
        setEntries((json.data ?? []) as AuditEntry[])
        if (json.pagination) setPaging(json.pagination as Pagination)
      })
      .finally(() => setLoading(false))
  }

  // Reload when the page changes or a filter changes (filters reset to page 1).
  useEffect(() => { load() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [page, action, table, from, to])

  function applyFilter<T>(setter: (v: T) => void, value: T) {
    setter(value)
    setPage(1)
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <MarketsAdminNav />
      <div>
        <h1 className="text-2xl font-bold text-white">Markets Audit</h1>
        <p className="text-zinc-400 text-sm mt-1">
          Every reference-data change: observation approvals, supersedes and document changes.
        </p>
      </div>

      {/* Filters */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Action</label>
          <select
            value={action}
            onChange={e => applyFilter(setAction, e.target.value)}
            className="h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
          >
            <option value="">All</option>
            {ACTIONS.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Table</label>
          <select
            value={table}
            onChange={e => applyFilter(setTable, e.target.value)}
            className="h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
          >
            <option value="">All</option>
            {TABLES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">From</label>
          <input
            type="date"
            value={from}
            onChange={e => applyFilter(setFrom, e.target.value)}
            className="h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">To</label>
          <input
            type="date"
            value={to}
            onChange={e => applyFilter(setTo, e.target.value)}
            className="h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
          />
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs text-zinc-500 mb-1">User id (actor)</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={actor}
              onChange={e => setActor(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { setPage(1); load() } }}
              placeholder="UUID…"
              className="flex-1 h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
            <button
              onClick={() => { setPage(1); load() }}
              className="h-9 px-3 text-sm text-zinc-300 border border-zinc-700 hover:border-zinc-500 rounded-md transition-colors"
            >
              Apply
            </button>
          </div>
        </div>
      </div>

      {/* Entries */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-xs text-zinc-500 uppercase tracking-wide">
              <th className="px-5 py-3 text-left">When</th>
              <th className="px-5 py-3 text-left">Actor</th>
              <th className="px-5 py-3 text-left">Action</th>
              <th className="px-5 py-3 text-left">Table</th>
              <th className="px-5 py-3 text-left">Row</th>
              <th className="px-5 py-3 text-left">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {loading && (
              <tr><td colSpan={6} className="px-5 py-8 text-center text-zinc-500">Loading…</td></tr>
            )}
            {!loading && entries.length === 0 && (
              <tr><td colSpan={6} className="px-5 py-8 text-center text-zinc-500">No audit entries match these filters.</td></tr>
            )}
            {!loading && entries.map(e => (
              <tr key={e.id} className="hover:bg-zinc-800/40 transition-colors align-top">
                <td className="px-5 py-3 text-zinc-400 whitespace-nowrap">{fmtDate(e.created_at)}</td>
                <td className="px-5 py-3 text-zinc-300 text-xs font-mono">{e.actor_email || e.actor_id || '—'}</td>
                <td className="px-5 py-3">
                  <span className={'text-xs px-2 py-0.5 rounded-full ' + (ACTION_COLOUR[e.action] ?? 'bg-zinc-700 text-zinc-300')}>
                    {e.action}
                  </span>
                </td>
                <td className="px-5 py-3 text-zinc-300 text-xs font-mono">{e.target_table}</td>
                <td className="px-5 py-3 text-zinc-500 text-xs font-mono">{e.row_id}</td>
                <td className="px-5 py-3 text-zinc-400 text-xs max-w-xs truncate">{e.note || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>{paging.total} entr{paging.total === 1 ? 'y' : 'ies'}</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="p-1.5 rounded border border-zinc-700 hover:border-zinc-500 disabled:opacity-40 transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span>Page {paging.page} of {paging.pages}</span>
          <button
            onClick={() => setPage(p => Math.min(paging.pages, p + 1))}
            disabled={page >= paging.pages}
            className="p-1.5 rounded border border-zinc-700 hover:border-zinc-500 disabled:opacity-40 transition-colors"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
