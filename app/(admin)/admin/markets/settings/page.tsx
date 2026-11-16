'use client'

import { useEffect, useState } from 'react'
import MarketsAdminNav from '@/components/admin/markets/MarketsAdminNav'

/**
 * Admin → Markets → Settings (MKT-8). Super-admin only. Reads and writes the
 * singleton market_settings row. Each setting carries a label telling the admin
 * WHEN the change reaches the live explorer:
 *   • "Applies now"               — consumed at request time already (cap /
 *                                   alert / reset timezone).
 *   • "Saved; takes effect after  — persisted here but not yet threaded through
 *      MKT-8b"                       compute.ts/explorer.ts/views.ts.
 */

interface Settings {
  headlineMeasures: string[]
  rankingSize: number
  coverageColumns: string[]
  defaultCommodity: string
  dailyTokenCap: number
  alertThresholdPct: number
  resetTimezone: string
  updatedAt: string | null
  updatedBy: string | null
}

interface Options {
  measures: string[]
  commodities: string[]
  coverageColumns: string[]
  rankingSizeMin: number
  rankingSizeMax: number
}

const APPLIES_NOW = 'Applies now (next page load)'
const AFTER_8B = 'Saved; takes effect after MKT-8b'

function Badge({ now }: { now: boolean }) {
  return (
    <span
      className={
        'text-[10px] font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ' +
        (now
          ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
          : 'bg-zinc-700/40 text-zinc-400 border-zinc-600/40')
      }
    >
      {now ? APPLIES_NOW : AFTER_8B}
    </span>
  )
}

export default function MarketsSettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [options, setOptions]   = useState<Options | null>(null)
  const [loading, setLoading]   = useState(true)
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [saved, setSaved]       = useState(false)

  function load() {
    setLoading(true)
    fetch('/api/admin/markets/settings')
      .then(r => r.json())
      .then(json => {
        if (json.data) setSettings(json.data as Settings)
        if (json.options) setOptions(json.options as Options)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  function patch(p: Partial<Settings>) {
    setSettings(s => (s ? { ...s, ...p } : s))
    setSaved(false)
  }

  function toggleHeadline(measure: string) {
    if (!settings) return
    const has = settings.headlineMeasures.includes(measure)
    patch({
      headlineMeasures: has
        ? settings.headlineMeasures.filter(m => m !== measure)
        : [...settings.headlineMeasures, measure],
    })
  }

  function toggleCoverage(col: string) {
    if (!settings) return
    const has = settings.coverageColumns.includes(col)
    patch({
      coverageColumns: has
        ? settings.coverageColumns.filter(c => c !== col)
        : [...settings.coverageColumns, col],
    })
  }

  async function save() {
    if (!settings) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const res = await fetch('/api/admin/markets/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Save failed')
      setSettings(json.data as Settings)
      setSaved(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      <MarketsAdminNav />
      <div>
        <h1 className="text-2xl font-bold text-white">Markets Settings</h1>
        <p className="text-zinc-400 text-sm mt-1">
          Global configuration for the Markets explorer. Each setting is labelled with when
          it reaches the live explorer.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-800 bg-red-950/40 px-4 py-2 text-sm text-red-300">{error}</div>
      )}
      {saved && (
        <div className="rounded-md border border-emerald-800 bg-emerald-950/40 px-4 py-2 text-sm text-emerald-300">
          Settings saved. Changes take effect on the next page load (no redeploy).
        </div>
      )}

      {loading || !settings || !options ? (
        <div className="text-zinc-500 text-sm">Loading…</div>
      ) : (
        <div className="space-y-5">
          {/* Headline measures */}
          <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-white">Headline measures & order</h2>
              <Badge now={false} />
            </div>
            <p className="text-xs text-zinc-500">
              Which measures appear as headline cards, in the order you add them. Click to toggle;
              the current order is shown below.
            </p>
            <div className="flex flex-wrap gap-2">
              {options.measures.map(m => {
                const on = settings.headlineMeasures.includes(m)
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => toggleHeadline(m)}
                    className={
                      'text-xs px-2.5 py-1 rounded border transition-colors ' +
                      (on
                        ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                        : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-500')
                    }
                  >
                    {m}
                  </button>
                )
              })}
            </div>
            <div className="text-xs text-zinc-500">
              Order: <span className="text-zinc-300">{settings.headlineMeasures.join(' → ') || '(none)'}</span>
            </div>
          </section>

          {/* Ranking size */}
          <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-white">Ranking size</h2>
              <Badge now={false} />
            </div>
            <p className="text-xs text-zinc-500">
              Rows shown per ranking list ({options.rankingSizeMin}–{options.rankingSizeMax}).
            </p>
            <input
              type="number"
              min={options.rankingSizeMin}
              max={options.rankingSizeMax}
              value={settings.rankingSize}
              onChange={e => patch({ rankingSize: parseInt(e.target.value, 10) || options.rankingSizeMin })}
              className="w-28 h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
          </section>

          {/* Coverage columns */}
          <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-white">Coverage columns</h2>
              <Badge now={false} />
            </div>
            <p className="text-xs text-zinc-500">
              Which coverage dimensions show on the Coverage tab. Select none to show all.
            </p>
            <div className="flex flex-wrap gap-2">
              {options.coverageColumns.map(c => {
                const on = settings.coverageColumns.includes(c)
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => toggleCoverage(c)}
                    className={
                      'text-xs px-2.5 py-1 rounded border transition-colors ' +
                      (on
                        ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                        : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-500')
                    }
                  >
                    {c}
                  </button>
                )
              })}
            </div>
          </section>

          {/* Default commodity */}
          <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-white">Default commodity</h2>
              <Badge now={false} />
            </div>
            <p className="text-xs text-zinc-500">The commodity the explorer opens on.</p>
            <select
              value={settings.defaultCommodity}
              onChange={e => patch({ defaultCommodity: e.target.value })}
              className="h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
            >
              {options.commodities.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </section>

          {/* Usage cap & alerts */}
          <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-white">Usage cap & alerts</h2>
              <Badge now={true} />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Daily token cap per user</label>
                <input
                  type="number"
                  min={0}
                  value={settings.dailyTokenCap}
                  onChange={e => patch({ dailyTokenCap: parseInt(e.target.value, 10) || 0 })}
                  className="w-full h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
                <p className="text-[11px] text-zinc-600 mt-1">0 = unlimited</p>
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Alert threshold (%)</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={settings.alertThresholdPct}
                  onChange={e => patch({ alertThresholdPct: parseInt(e.target.value, 10) || 0 })}
                  className="w-full h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Reset timezone</label>
                <input
                  type="text"
                  value={settings.resetTimezone}
                  onChange={e => patch({ resetTimezone: e.target.value })}
                  className="w-full h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
                <p className="text-[11px] text-zinc-600 mt-1">e.g. Australia/Perth</p>
              </div>
            </div>
          </section>

          {/* Save */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-600">
              {settings.updatedAt
                ? `Last updated ${new Date(settings.updatedAt).toLocaleString('en-AU')}`
                : 'Not yet saved'}
            </span>
            <button
              onClick={save}
              disabled={saving}
              className="h-9 px-5 text-sm font-medium bg-amber-500 hover:bg-amber-400 text-black rounded-md transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
