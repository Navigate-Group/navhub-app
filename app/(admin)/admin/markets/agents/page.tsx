'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

/**
 * Admin Market Analyst config (MKT-5). Super-admin only (gated by the admin
 * layout + the API route). Lets the operator enable/disable the agent, pick the
 * model, edit the analysis + chat prompts, maintain the suggested-question
 * chips (CSV) and set the analysis cache TTL. Changes apply immediately to new
 * runs.
 */

interface ModelOption { value: string; label: string }

interface AnalystConfig {
  enabled: boolean
  model: string
  analysisPrompt: string
  chatPrompt: string
  suggestions: string[]
  cacheTtlHours: number
}

export default function AdminMarketsAgentsPage() {
  const [config, setConfig]   = useState<AnalystConfig | null>(null)
  const [models, setModels]   = useState<ModelOption[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [saved, setSaved]     = useState(false)

  // Editable fields
  const [enabled, setEnabled]               = useState(true)
  const [model, setModel]                   = useState('')
  const [analysisPrompt, setAnalysisPrompt] = useState('')
  const [chatPrompt, setChatPrompt]         = useState('')
  const [suggestionsCsv, setSuggestionsCsv] = useState('')
  const [cacheTtlHours, setCacheTtlHours]   = useState(24)

  function hydrate(c: AnalystConfig) {
    setConfig(c)
    setEnabled(c.enabled)
    setModel(c.model)
    setAnalysisPrompt(c.analysisPrompt)
    setChatPrompt(c.chatPrompt)
    setSuggestionsCsv(c.suggestions.join(', '))
    setCacheTtlHours(c.cacheTtlHours)
  }

  useEffect(() => {
    fetch('/api/admin/markets/agents')
      .then(r => r.json())
      .then(json => {
        if (json.data) hydrate(json.data as AnalystConfig)
        if (json.models) setModels(json.models as ModelOption[])
      })
      .catch(() => setError('Could not load config.'))
      .finally(() => setLoading(false))
  }, [])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const res = await fetch('/api/admin/markets/agents', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled,
          model,
          analysisPrompt,
          chatPrompt,
          suggestions: suggestionsCsv,
          cacheTtlHours,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      hydrate(json.data as AnalystConfig)
      setSaved(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const inputClass = 'w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-amber-500'

  return (
    <div className="p-6 space-y-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-white">Market Analyst</h1>
          <p className="text-zinc-400 text-sm mt-1">
            Configure the Market Analyst agent. Changes apply immediately to new runs.
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href="/admin/markets" className="text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 px-3 py-1.5 rounded transition-colors">Access</Link>
          <Link href="/admin/markets/usage" className="text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 px-3 py-1.5 rounded transition-colors">Usage</Link>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-800 bg-red-950/40 px-4 py-2 text-sm text-red-300">{error}</div>
      )}
      {saved && (
        <div className="rounded-md border border-green-800 bg-green-950/40 px-4 py-2 text-sm text-green-300">Saved.</div>
      )}

      {loading ? (
        <div className="text-zinc-500 text-sm">Loading…</div>
      ) : config == null ? (
        <div className="text-zinc-500 text-sm">No config available.</div>
      ) : (
        <form onSubmit={save} className="space-y-5">
          {/* Enable / disable */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-white">Agent enabled</h2>
              <p className="text-xs text-zinc-500 mt-0.5">When off, viewers see the deterministic fallback facts instead of agent analysis.</p>
            </div>
            <label className="inline-flex items-center cursor-pointer">
              <input type="checkbox" className="sr-only peer" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
              <span className="relative w-11 h-6 bg-zinc-700 rounded-full peer-checked:bg-amber-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5" />
            </label>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            {/* Model */}
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Model</label>
              <select value={model} onChange={e => setModel(e.target.value)} className={inputClass}>
                {models.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>

            {/* Cache TTL */}
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Analysis cache TTL (hours)</label>
              <input
                type="number"
                min={0}
                max={8760}
                value={cacheTtlHours}
                onChange={e => setCacheTtlHours(Number(e.target.value))}
                className={inputClass}
              />
              <p className="text-xs text-zinc-600 mt-1">0 disables caching. The Re-run button always bypasses the cache.</p>
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            {/* Analysis prompt */}
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Analysis prompt</label>
              <textarea value={analysisPrompt} onChange={e => setAnalysisPrompt(e.target.value)} rows={6} className={inputClass} />
            </div>
            {/* Chat prompt */}
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Chat prompt</label>
              <textarea value={chatPrompt} onChange={e => setChatPrompt(e.target.value)} rows={5} className={inputClass} />
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-2">
            {/* Suggested questions */}
            <label className="block text-xs text-zinc-500 mb-1">Suggested questions (comma-separated)</label>
            <textarea value={suggestionsCsv} onChange={e => setSuggestionsCsv(e.target.value)} rows={3} className={inputClass} placeholder="Where is the biggest gap…, Which exporters earn the most…" />
            <p className="text-xs text-zinc-600">These appear as clickable chips in the chat panel. Three or more recommended.</p>
          </div>

          <div className="flex justify-end">
            <button type="submit" disabled={busy} className="h-9 px-5 text-sm font-medium bg-amber-500 hover:bg-amber-400 text-black rounded-md transition-colors disabled:opacity-50">
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
