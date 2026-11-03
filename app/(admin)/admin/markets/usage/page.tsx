import Link from 'next/link'
import { getAnalystUsageRollup } from '@/lib/markets/analyst'

/**
 * Admin Market Analyst usage rollup (MKT-5). Super-admin only (gated by the
 * admin layout). Shows tokens per user per agent on the Markets dashboard — a
 * quick read of who is driving analyst usage and how much.
 */

export const dynamic = 'force-dynamic'

const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

export default async function AdminMarketsUsagePage() {
  const rows = await getAnalystUsageRollup()
  const totals = rows.reduce(
    (acc, r) => ({
      runs: acc.runs + r.runs,
      input: acc.input + r.input_tokens,
      output: acc.output + r.output_tokens,
      total: acc.total + r.total_tokens,
    }),
    { runs: 0, input: 0, output: 0, total: 0 },
  )

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-white">Market Analyst usage</h1>
          <p className="text-zinc-400 text-sm mt-1">Tokens per user for the Market Analyst agent.</p>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href="/admin/markets" className="text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 px-3 py-1.5 rounded transition-colors">Access</Link>
          <Link href="/admin/markets/agents" className="text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 px-3 py-1.5 rounded transition-colors">Agent config</Link>
        </div>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Runs', value: totals.runs },
          { label: 'Input tokens', value: totals.input },
          { label: 'Output tokens', value: totals.output },
          { label: 'Total tokens', value: totals.total },
        ].map(s => (
          <div key={s.label} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            <p className="text-xs text-zinc-500 uppercase tracking-wide">{s.label}</p>
            <p className="mt-1 text-2xl font-bold text-white tabular-nums">{INT.format(s.value)}</p>
          </div>
        ))}
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-xs text-zinc-500 uppercase tracking-wide">
              <th className="px-5 py-3 text-left">User</th>
              <th className="px-5 py-3 text-right">Runs</th>
              <th className="px-5 py-3 text-right">Input</th>
              <th className="px-5 py-3 text-right">Output</th>
              <th className="px-5 py-3 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {rows.length === 0 && (
              <tr><td colSpan={5} className="px-5 py-8 text-center text-zinc-500">No analyst usage recorded yet.</td></tr>
            )}
            {rows.map(r => (
              <tr key={r.user_id ?? 'unknown'} className="hover:bg-zinc-800/40 transition-colors">
                <td className="px-5 py-3 text-white font-mono text-xs">{r.email || r.user_id || 'Unknown'}</td>
                <td className="px-5 py-3 text-right text-zinc-300 tabular-nums">{INT.format(r.runs)}</td>
                <td className="px-5 py-3 text-right text-zinc-300 tabular-nums">{INT.format(r.input_tokens)}</td>
                <td className="px-5 py-3 text-right text-zinc-300 tabular-nums">{INT.format(r.output_tokens)}</td>
                <td className="px-5 py-3 text-right text-white tabular-nums font-medium">{INT.format(r.total_tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
