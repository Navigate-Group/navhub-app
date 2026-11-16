'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react'

interface AuditEntry {
  id:           string
  actor_id:     string | null
  actor_email:  string | null
  action:       string
  target_table: string
  row_id:       string
  old_value:    Record<string, unknown> | null
  new_value:    Record<string, unknown> | null
  note:         string | null
  created_at:   string
}

interface Pagination { page: number; limit: number; total: number; pages: number }

const ACTION_COLOUR: Record<string, string> = {
  insert:  'bg-green-900/50 text-green-300',
  update:  'bg-blue-900/50 text-blue-300',
  archive: 'bg-amber-900/50 text-amber-300',
  restore: 'bg-emerald-900/50 text-emerald-300',
  delete:  'bg-red-900/50 text-red-300',
}

const ACTIONS = ['insert', 'update', 'archive', 'restore', 'delete']

// The Markets reference / fact tables that write to the audit log.
const TABLES = [
  'markets_commodities',
  'markets_geo_units',
  'markets_seasons',
  'markets_measures',
  'markets_sources',
  'markets_prices',
  'markets_observations',
  'markets_fx',
  'markets_structure',
  'markets_operators',
  'markets_documents',
]

function fmtDate(s: string) {
  return new Date(s).toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}
function tableLabel(t: string) {
  return t.replace(/^markets_/, '').replace(/_/g, ' ')
}

export default function AdminMarketsAuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [paging,  setPaging]  = useState<Pagination>({ page: 1, limit: 50, total: 0, pages: 1 })
  const [page,    setPage]    = useState(1)
  const [loading, setLoading] = useState(true)
  const [action,  setAction]  = useState('')
  const [table,   setTable]   = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams({ page: String(page), limit: '50' })
    if (action) params.set('action', action)
    if (table)  params.set('target_table', table)

    fetch(`/api/admin/markets/audit?${params}`)
      .then(r => r.json())
      .then(json => {
        setEntries((json.data ?? []) as AuditEntry[])
        if (json.pagination) setPaging(json.pagination as Pagination)
      })
      .finally(() => setLoading(false))
  }, [page, action, table])

  function onFilter(newAction: string, newTable: string) {
    setPage(1); setAction(newAction); setTable(newTable)
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <Link
          href="/admin/markets"
          className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1 min-w-[200px]">
          <h1 className="text-xl font-semibold text-zinc-100">Markets Audit Log</h1>
          <p className="text-xs text-zinc-400 mt-0.5">
            Every change to Markets reference data — who, what, when, and before / after values.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={table}
            onChange={e => onFilter(action, e.target.value)}
            className="h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
          >
            <option value="">All tables</option>
            {TABLES.map(t => <option key={t} value={t} className="capitalize">{tableLabel(t)}</option>)}
          </select>
          <select
            value={action}
            onChange={e => onFilter(e.target.value, table)}
            className="h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
          >
            <option value="">All actions</option>
            {ACTIONS.map(a => <option key={a} value={a} className="capitalize">{a}</option>)}
          </select>
        </div>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-xs text-zinc-500 uppercase tracking-wide">
              <th className="px-5 py-3 text-left">Timestamp</th>
              <th className="px-5 py-3 text-left">Actor</th>
              <th className="px-5 py-3 text-left">Action</th>
              <th className="px-5 py-3 text-left">Table</th>
              <th className="px-5 py-3 text-left">Row</th>
              <th className="px-5 py-3 text-left">Change</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {loading && (
              <tr><td colSpan={6} className="px-5 py-8 text-center text-zinc-500">Loading…</td></tr>
            )}
            {!loading && entries.length === 0 && (
              <tr><td colSpan={6} className="px-5 py-8 text-center text-zinc-500">No audit entries found.</td></tr>
            )}
            {entries.map(e => {
              const isOpen = expanded === e.id
              return (
                <tr key={e.id} className="hover:bg-zinc-800/30 transition-colors align-top">
                  <td className="px-5 py-3 text-zinc-400 text-xs whitespace-nowrap">{fmtDate(e.created_at)}</td>
                  <td className="px-5 py-3 text-zinc-300 text-xs truncate max-w-[180px]">
                    {e.actor_email ?? e.actor_id ?? '—'}
                  </td>
                  <td className="px-5 py-3">
                    <span className={`text-[11px] px-2 py-0.5 rounded-full capitalize whitespace-nowrap ${ACTION_COLOUR[e.action] ?? 'bg-zinc-700 text-zinc-300'}`}>
                      {e.action}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-zinc-400 text-xs capitalize">{tableLabel(e.target_table)}</td>
                  <td className="px-5 py-3 text-zinc-500 text-[10px] font-mono truncate max-w-[140px]">{e.row_id}</td>
                  <td className="px-5 py-3 text-zinc-500 text-xs">
                    <button
                      onClick={() => setExpanded(isOpen ? null : e.id)}
                      className="text-amber-400 hover:text-amber-300 text-xs"
                    >
                      {isOpen ? 'Hide' : 'View'} diff
                    </button>
                    {e.note && <p className="text-zinc-500 mt-1 italic">{e.note}</p>}
                    {isOpen && (
                      <div className="mt-2 grid gap-2 md:grid-cols-2">
                        <div>
                          <p className="text-[10px] uppercase tracking-wide text-zinc-600 mb-1">Before</p>
                          <pre className="text-[10px] font-mono bg-zinc-950 border border-zinc-800 rounded p-2 overflow-x-auto max-h-60 text-zinc-400">
                            {e.old_value ? JSON.stringify(e.old_value, null, 2) : '—'}
                          </pre>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wide text-zinc-600 mb-1">After</p>
                          <pre className="text-[10px] font-mono bg-zinc-950 border border-zinc-800 rounded p-2 overflow-x-auto max-h-60 text-zinc-400">
                            {e.new_value ? JSON.stringify(e.new_value, null, 2) : '—'}
                          </pre>
                        </div>
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {paging.pages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-xs text-zinc-500">
            Page {paging.page} of {paging.pages} · {paging.total.toLocaleString()} entries
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="p-1.5 rounded border border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => setPage(p => Math.min(paging.pages, p + 1))}
              disabled={page >= paging.pages}
              className="p-1.5 rounded border border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
