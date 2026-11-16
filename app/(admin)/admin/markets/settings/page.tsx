'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Loader2, CheckCircle2, AlertCircle, ChevronUp, ChevronDown, X } from 'lucide-react'

interface MeasureOption { id: string; label: string; short: string }
interface CommodityOption { id: string; name: string }
interface CoverageDimension {
  label: string
  kind: string
  measure?: string
  classification?: string
}

interface Settings {
  headlineMeasures:   string[]
  rankingMeasures:    string[]
  rankingSize:        number
  coverageTopN:       number
  coverageDimensions: CoverageDimension[]
  defaultCommodity:   string
  dailyTokenCap:      number
  tokenAlertPercent:  number
}

export default function AdminMarketsSettingsPage() {
  const [settings,  setSettings]  = useState<Settings | null>(null)
  const [measures,  setMeasures]  = useState<MeasureOption[]>([])
  const [commodities, setCommodities] = useState<CommodityOption[]>([])
  const [loading,   setLoading]   = useState(true)
  const [saving,    setSaving]    = useState(false)
  const [toast,     setToast]     = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  useEffect(() => {
    fetch('/api/admin/markets/settings')
      .then(r => r.json())
      .then(json => {
        if (json.data) setSettings(json.data as Settings)
        if (json.catalogue) {
          setMeasures((json.catalogue.measures ?? []) as MeasureOption[])
          setCommodities((json.catalogue.commodities ?? []) as CommodityOption[])
        }
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  function measureLabel(id: string): string {
    return measures.find(m => m.id === id)?.short ?? id
  }

  function patch(p: Partial<Settings>) {
    setSettings(s => (s ? { ...s, ...p } : s))
  }

  // ── Ordered measure list editors (headline / ranking) ──────────────────────
  function moveMeasure(key: 'headlineMeasures' | 'rankingMeasures', index: number, dir: -1 | 1) {
    if (!settings) return
    const list = [...settings[key]]
    const target = index + dir
    if (target < 0 || target >= list.length) return
    ;[list[index], list[target]] = [list[target], list[index]]
    patch({ [key]: list } as Partial<Settings>)
  }
  function removeMeasure(key: 'headlineMeasures' | 'rankingMeasures', index: number) {
    if (!settings) return
    const list = settings[key].filter((_, i) => i !== index)
    patch({ [key]: list } as Partial<Settings>)
  }
  function addMeasure(key: 'headlineMeasures' | 'rankingMeasures', id: string) {
    if (!settings || !id || settings[key].includes(id)) return
    patch({ [key]: [...settings[key], id] } as Partial<Settings>)
  }

  async function handleSave() {
    if (!settings) return
    setSaving(true)
    try {
      const res = await fetch('/api/admin/markets/settings', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(settings),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Save failed')
      setSettings(json.data as Settings)
      setToast({ type: 'success', message: 'Markets settings saved.' })
    } catch (err) {
      setToast({ type: 'error', message: err instanceof Error ? err.message : 'Save failed' })
    } finally {
      setSaving(false)
    }
  }

  if (loading || !settings) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-6 w-6 text-zinc-400 animate-spin" />
        </div>
      </div>
    )
  }

  const available = (selected: string[]) => measures.filter(m => !selected.includes(m.id))

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/admin/markets"
          className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-zinc-100">Markets Settings</h1>
          <p className="text-xs text-zinc-400 mt-0.5">
            Global explorer display configuration and the Market Analyst usage cap. Applies to all Markets users.
          </p>
        </div>
      </div>

      {/* Display configuration */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 space-y-6">
        <h2 className="text-sm font-semibold text-zinc-100">Display configuration</h2>

        {/* Headline measures */}
        <MeasureListEditor
          title="Headline measures"
          hint="The measure cards shown at the top of the explorer, in order."
          list={settings.headlineMeasures}
          label={measureLabel}
          available={available(settings.headlineMeasures)}
          onMove={(i, d) => moveMeasure('headlineMeasures', i, d)}
          onRemove={i => removeMeasure('headlineMeasures', i)}
          onAdd={id => addMeasure('headlineMeasures', id)}
        />

        {/* Ranking measures */}
        <MeasureListEditor
          title="Ranking measures"
          hint="The measures offered in the ranking / map selector, in order."
          list={settings.rankingMeasures}
          label={measureLabel}
          available={available(settings.rankingMeasures)}
          onMove={(i, d) => moveMeasure('rankingMeasures', i, d)}
          onRemove={i => removeMeasure('rankingMeasures', i)}
          onAdd={id => addMeasure('rankingMeasures', id)}
        />

        {/* Numeric knobs + default commodity */}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-300">Ranking size</label>
            <input
              type="number" min={1}
              value={settings.rankingSize}
              onChange={e => patch({ rankingSize: Math.max(1, parseInt(e.target.value || '1', 10)) })}
              className="w-full h-9 px-3 rounded border border-zinc-700 bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-300">Coverage top-N</label>
            <input
              type="number" min={1}
              value={settings.coverageTopN}
              onChange={e => patch({ coverageTopN: Math.max(1, parseInt(e.target.value || '1', 10)) })}
              className="w-full h-9 px-3 rounded border border-zinc-700 bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-300">Default commodity</label>
            <select
              value={settings.defaultCommodity}
              onChange={e => patch({ defaultCommodity: e.target.value })}
              className="w-full h-9 px-3 rounded border border-zinc-700 bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500"
            >
              <option value="">(first available)</option>
              {commodities.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Coverage columns (read-only ordering list) */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-zinc-300">Coverage columns</label>
          <p className="text-xs text-zinc-500">The columns shown in the coverage table, in order.</p>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {settings.coverageDimensions.map((d, i) => (
              <span key={`${d.label}-${i}`} className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
                <span className="text-zinc-500">{i + 1}.</span>{d.label}
                <button
                  onClick={() => patch({ coverageDimensions: settings.coverageDimensions.filter((_, j) => j !== i) })}
                  className="text-zinc-500 hover:text-red-400"
                  title="Remove column"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {settings.coverageDimensions.length === 0 && (
              <span className="text-xs text-zinc-600">No coverage columns configured.</span>
            )}
          </div>
        </div>
      </section>

      {/* Usage cap */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 space-y-4">
        <h2 className="text-sm font-semibold text-zinc-100">Market Analyst usage cap</h2>
        <p className="text-xs text-zinc-400">
          Per-user daily token cap for the Market Analyst agent. A user who reaches the cap is cut off
          for the rest of the UTC day. Set to <span className="font-mono">0</span> for unlimited.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-300">Daily token cap (per user)</label>
            <input
              type="number" min={0}
              value={settings.dailyTokenCap}
              onChange={e => patch({ dailyTokenCap: Math.max(0, parseInt(e.target.value || '0', 10)) })}
              className="w-full h-9 px-3 rounded border border-zinc-700 bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-300">Alert threshold (% of cap)</label>
            <input
              type="number" min={0} max={100}
              value={settings.tokenAlertPercent}
              onChange={e => patch({ tokenAlertPercent: Math.min(100, Math.max(0, parseInt(e.target.value || '0', 10))) })}
              className="w-full h-9 px-3 rounded border border-zinc-700 bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
          </div>
        </div>
        <p className="text-xs text-zinc-500">
          Users at or above the alert threshold are flagged on the{' '}
          <Link href="/admin/markets/usage" className="text-amber-400 hover:text-amber-300 underline">usage page</Link>.
        </p>
      </section>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 rounded bg-amber-500 text-black font-semibold text-sm hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Saving…</span> : 'Save settings'}
        </button>
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-4 right-4 z-50">
          <div className={`flex items-start gap-3 px-4 py-3 rounded-lg border shadow-lg ${
            toast.type === 'success'
              ? 'bg-emerald-900/90 border-emerald-700 text-emerald-100'
              : 'bg-red-900/90 border-red-700 text-red-100'
          }`}>
            {toast.type === 'success'
              ? <CheckCircle2 className="h-5 w-5 shrink-0" />
              : <AlertCircle className="h-5 w-5 shrink-0" />}
            <div className="text-sm">{toast.message}</div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Reusable ordered measure-list editor ──────────────────────────────────────
function MeasureListEditor(props: {
  title: string
  hint: string
  list: string[]
  label: (id: string) => string
  available: MeasureOption[]
  onMove: (index: number, dir: -1 | 1) => void
  onRemove: (index: number) => void
  onAdd: (id: string) => void
}) {
  const { title, hint, list, label, available, onMove, onRemove, onAdd } = props
  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-zinc-300">{title}</label>
      <p className="text-xs text-zinc-500">{hint}</p>
      <div className="space-y-1.5 pt-1">
        {list.map((id, i) => (
          <div key={id} className="flex items-center gap-2 bg-zinc-950 border border-zinc-800 rounded px-3 py-1.5">
            <span className="text-xs text-zinc-500 w-5">{i + 1}.</span>
            <span className="flex-1 text-sm text-zinc-200">{label(id)}</span>
            <button onClick={() => onMove(i, -1)} disabled={i === 0}
              className="p-1 rounded text-zinc-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed" title="Move up">
              <ChevronUp className="h-4 w-4" />
            </button>
            <button onClick={() => onMove(i, 1)} disabled={i === list.length - 1}
              className="p-1 rounded text-zinc-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed" title="Move down">
              <ChevronDown className="h-4 w-4" />
            </button>
            <button onClick={() => onRemove(i)}
              className="p-1 rounded text-zinc-500 hover:text-red-400" title="Remove">
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
        {list.length === 0 && <p className="text-xs text-zinc-600">None selected.</p>}
      </div>
      {available.length > 0 && (
        <select
          value=""
          onChange={e => { if (e.target.value) onAdd(e.target.value) }}
          className="mt-1 h-8 px-2 rounded border border-zinc-700 bg-zinc-950 text-zinc-300 text-xs focus:outline-none focus:ring-1 focus:ring-amber-500"
        >
          <option value="">+ Add measure…</option>
          {available.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      )}
    </div>
  )
}
