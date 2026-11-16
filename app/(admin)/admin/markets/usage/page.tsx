'use client'

import { useEffect, useState } from 'react'
import MarketsAdminNav from '@/components/admin/markets/MarketsAdminNav'

/**
 * Admin → Markets → Usage (MKT-8). Super-admin only. Token counts by user and
 * by agent (Market Analyst, Document Extractor), with each user's today total vs.
 * the cap and alert threshold. Users over the alert threshold are highlighted.
 */

interface UserRow {
  userId: string
  email: string
  marketAnalystTokens: number
  marketAnalystRuns: number
  documentExtractorTokens: number
  documentExtractorRuns: number
  totalTokens: number
  tokensToday: number
  overAlertThreshold: boolean
  overCap: boolean
}

interface Report {
  totals: {
    marketAnalystTokens: number
    marketAnalystRuns: number
    documentExtractorTokens: number
    documentExtractorRuns: number
  }
  users: UserRow[]
  cap: number
  alertThresholdPct: number
  resetTimezone: string
  alertingUsers: number
  windowDays: number | null
}

const WINDOWS = [
  { label: '7 days', value: '7' },
  { label: '30 days', value: '30' },
  { label: '90 days', value: '90' },
  { label: 'All time', value: 'all' },
]

function fmt(n: number) {
  return n.toLocaleString('en-AU')
}

export default function MarketsUsagePage() {
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [window, setWindow] = useState('30')

  function load(w: string) {
    setLoading(true)
    fetch(`/api/admin/markets/usage?window=${encodeURIComponent(w)}`)
      .then(r => r.json())
      .then(json => setReport((json.data ?? null) as Report | null))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load(window) }, [window])

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <MarketsAdminNav />
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Markets Usage</h1>
          <p className="text-zinc-400 text-sm mt-1">
            Token usage by user and agent. Daily totals reset at midnight
            {report ? ` (${report.resetTimezone})` : ''}.
          </p>
        </div>
        <select
          value={window}
          onChange={e => setWindow(e.target.value)}
          className="h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
        >
          {WINDOWS.map(w => (
            <option key={w.value} value={w.value}>{w.label}</option>
          ))}
        </select>
      </div>

      {loading || !report ? (
        <div className="text-zinc-500 text-sm">Loading…</div>
      ) : (
        <>
          {/* Alert banner */}
          {report.alertingUsers > 0 && (
            <div className="rounded-md border border-amber-700 bg-amber-950/40 px-4 py-2 text-sm text-amber-300">
              {report.alertingUsers} user{report.alertingUsers === 1 ? '' : 's'} crossed the
              {' '}{report.alertThresholdPct}% alert threshold today
              {report.cap > 0 ? ` (cap ${fmt(report.cap)} tokens/day)` : ''}.
            </div>
          )}

          {/* Per-agent totals */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-white">Market Analyst</h2>
              <p className="text-2xl font-bold text-amber-300 mt-2">{fmt(report.totals.marketAnalystTokens)}</p>
              <p className="text-xs text-zinc-500 mt-1">tokens · {fmt(report.totals.marketAnalystRuns)} runs</p>
            </div>
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-white">Document Extractor</h2>
              <p className="text-2xl font-bold text-sky-300 mt-2">{fmt(report.totals.documentExtractorTokens)}</p>
              <p className="text-xs text-zinc-500 mt-1">tokens · {fmt(report.totals.documentExtractorRuns)} runs</p>
            </div>
          </div>

          {/* Per-user breakdown */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-xs text-zinc-500 uppercase tracking-wide">
                  <th className="px-5 py-3 text-left">User</th>
                  <th className="px-5 py-3 text-right">Analyst tokens</th>
                  <th className="px-5 py-3 text-right">Extractor tokens</th>
                  <th className="px-5 py-3 text-right">Total</th>
                  <th className="px-5 py-3 text-right">Today vs cap</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {report.users.length === 0 && (
                  <tr><td colSpan={5} className="px-5 py-8 text-center text-zinc-500">No usage recorded in this window.</td></tr>
                )}
                {report.users.map(u => (
                  <tr key={u.userId} className="hover:bg-zinc-800/40 transition-colors">
                    <td className="px-5 py-3 text-white text-xs font-mono">{u.email || u.userId}</td>
                    <td className="px-5 py-3 text-right text-zinc-300">{fmt(u.marketAnalystTokens)}</td>
                    <td className="px-5 py-3 text-right text-zinc-300">{fmt(u.documentExtractorTokens)}</td>
                    <td className="px-5 py-3 text-right text-white font-medium">{fmt(u.totalTokens)}</td>
                    <td className="px-5 py-3 text-right">
                      <span
                        className={
                          'text-xs font-medium ' +
                          (u.overCap
                            ? 'text-red-400'
                            : u.overAlertThreshold
                              ? 'text-amber-400'
                              : 'text-zinc-400')
                        }
                      >
                        {fmt(u.tokensToday)}{report.cap > 0 ? ` / ${fmt(report.cap)}` : ' / ∞'}
                        {u.overCap ? ' · capped' : u.overAlertThreshold ? ' · alert' : ''}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
