'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Loader2, AlertTriangle } from 'lucide-react'

interface UserRow {
  user_id:        string
  email:          string | null
  tokens:         number
  runs:           number
  cachedRuns:     number
  errors:         number
  usedToday:      number
  overCap:        boolean
  approachingCap: boolean
  lastAt:         string
}
interface TypeRow { type: string; tokens: number; runs: number }
interface DayRow  { day: string; tokens: number; runs: number }

interface UsagePayload {
  data: {
    users:  UserRow[]
    byType: TypeRow[]
    daily:  DayRow[]
    totals: { tokens: number; runs: number; users: number }
  }
  settings: { dailyTokenCap: number; tokenAlertPercent: number }
  window:   { days: number }
}

const TYPE_LABELS: Record<string, string> = {
  chat:        'Analyst chat',
  ranking:     'Ranking tool',
  country:     'Country profile',
  change_view: 'Change view',
  other:       'Other',
}

function fmtInt(n: number) { return n.toLocaleString('en-AU') }
function fmtDate(s: string) {
  return new Date(s).toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export default function AdminMarketsUsagePage() {
  const [payload, setPayload] = useState<UsagePayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [days,    setDays]    = useState(30)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/admin/markets/usage?days=${days}`)
      .then(r => r.json())
      .then(json => setPayload(json as UsagePayload))
      .finally(() => setLoading(false))
  }, [days])

  const cap = payload?.settings.dailyTokenCap ?? 0
  const maxDaily = Math.max(1, ...(payload?.data.daily ?? []).map(d => d.tokens))

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <Link
          href="/admin/markets"
          className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1 min-w-[200px]">
          <h1 className="text-xl font-semibold text-zinc-100">Markets Usage</h1>
          <p className="text-xs text-zinc-400 mt-0.5">
            Market Analyst token usage by user, agent and day.
          </p>
        </div>
        <select
          value={days}
          onChange={e => setDays(parseInt(e.target.value, 10))}
          className="h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last 365 days</option>
        </select>
      </div>

      {loading && (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-6 w-6 text-zinc-400 animate-spin" />
        </div>
      )}

      {!loading && payload && (
        <>
          {/* Totals */}
          <div className="grid gap-4 sm:grid-cols-4">
            <StatCard label="Total tokens" value={fmtInt(payload.data.totals.tokens)} />
            <StatCard label="Total runs"   value={fmtInt(payload.data.totals.runs)} />
            <StatCard label="Active users" value={fmtInt(payload.data.totals.users)} />
            <StatCard label="Daily cap / user" value={cap > 0 ? fmtInt(cap) : 'Unlimited'} />
          </div>

          {/* Daily totals bar list */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-3">Daily token totals</h2>
            {payload.data.daily.length === 0 ? (
              <p className="text-sm text-zinc-500">No usage in this window.</p>
            ) : (
              <div className="space-y-1.5">
                {payload.data.daily.map(d => (
                  <div key={d.day} className="flex items-center gap-3 text-xs">
                    <span className="w-24 text-zinc-400 font-mono shrink-0">{d.day}</span>
                    <div className="flex-1 bg-zinc-800 rounded h-4 overflow-hidden">
                      <div
                        className="h-full bg-amber-500/70"
                        style={{ width: `${Math.round((d.tokens / maxDaily) * 100)}%` }}
                      />
                    </div>
                    <span className="w-20 text-right text-zinc-300 font-mono shrink-0">{fmtInt(d.tokens)}</span>
                    <span className="w-16 text-right text-zinc-500 shrink-0">{fmtInt(d.runs)} runs</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* By agent / view type */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-zinc-800">
              <h2 className="text-sm font-semibold text-white">By agent / view type</h2>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-xs text-zinc-500 uppercase tracking-wide">
                  <th className="px-5 py-2.5 text-left">Type</th>
                  <th className="px-5 py-2.5 text-right">Runs</th>
                  <th className="px-5 py-2.5 text-right">Tokens</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {payload.data.byType.length === 0 && (
                  <tr><td colSpan={3} className="px-5 py-6 text-center text-zinc-500">No usage.</td></tr>
                )}
                {payload.data.byType.map(t => (
                  <tr key={t.type} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="px-5 py-2.5 text-zinc-200">{TYPE_LABELS[t.type] ?? t.type}</td>
                    <td className="px-5 py-2.5 text-right text-zinc-400">{fmtInt(t.runs)}</td>
                    <td className="px-5 py-2.5 text-right text-zinc-300 font-mono">{fmtInt(t.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* By user */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-zinc-800">
              <h2 className="text-sm font-semibold text-white">By user</h2>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-xs text-zinc-500 uppercase tracking-wide">
                  <th className="px-5 py-2.5 text-left">User</th>
                  <th className="px-5 py-2.5 text-right">Tokens</th>
                  <th className="px-5 py-2.5 text-right">Runs</th>
                  <th className="px-5 py-2.5 text-right">Cached</th>
                  <th className="px-5 py-2.5 text-right">Errors</th>
                  <th className="px-5 py-2.5 text-right">Today</th>
                  <th className="px-5 py-2.5 text-left">Last used</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {payload.data.users.length === 0 && (
                  <tr><td colSpan={7} className="px-5 py-6 text-center text-zinc-500">No usage.</td></tr>
                )}
                {payload.data.users.map(u => (
                  <tr key={u.user_id} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="px-5 py-2.5 text-zinc-200 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="truncate max-w-[220px]">{u.email ?? u.user_id}</span>
                        {u.overCap && (
                          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-red-900/50 text-red-300">
                            <AlertTriangle className="h-3 w-3" /> Over cap
                          </span>
                        )}
                        {!u.overCap && u.approachingCap && (
                          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-900/50 text-amber-300">
                            <AlertTriangle className="h-3 w-3" /> Near cap
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-2.5 text-right text-zinc-300 font-mono">{fmtInt(u.tokens)}</td>
                    <td className="px-5 py-2.5 text-right text-zinc-400">{fmtInt(u.runs)}</td>
                    <td className="px-5 py-2.5 text-right text-zinc-500">{fmtInt(u.cachedRuns)}</td>
                    <td className="px-5 py-2.5 text-right text-zinc-500">{fmtInt(u.errors)}</td>
                    <td className={`px-5 py-2.5 text-right font-mono ${u.overCap ? 'text-red-400' : u.approachingCap ? 'text-amber-400' : 'text-zinc-400'}`}>
                      {fmtInt(u.usedToday)}{cap > 0 && <span className="text-zinc-600"> / {fmtInt(cap)}</span>}
                    </td>
                    <td className="px-5 py-2.5 text-zinc-500 text-xs whitespace-nowrap">{fmtDate(u.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-zinc-600">
            Caps are configured on the{' '}
            <Link href="/admin/markets/settings" className="text-amber-400 hover:text-amber-300 underline">settings page</Link>.
            &nbsp;&ldquo;Today&rdquo; is measured against the current UTC day.
          </p>
        </>
      )}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-xl font-semibold text-white mt-1">{value}</p>
    </div>
  )
}
