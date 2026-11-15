'use client'

import { useMemo, useState } from 'react'
import { Loader2, X, Plus, Check, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from './Toaster'
import type { EntryView, RefOption } from './ReviewQueueManager'

/**
 * Edit modal for a pending review-queue observation (MKT-7b). Lets a Manager
 * correct value / unit / commodity / geo / measure / season / source / note,
 * resolve an unmatched commodity (inline quick-add) or geography (fuzzy picker),
 * validate (null commodity / geo is rejected), save, and optionally approve in
 * one step.
 */

interface Props {
  entry: EntryView
  commodities: RefOption[]
  geographies: RefOption[]
  sources: RefOption[]
  onClose: () => void
  onSaved: () => Promise<void> | void
  onApproved: () => Promise<void> | void
}

function norm(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').trim()
}

export default function EditObservationModal({
  entry, commodities, geographies, sources, onClose, onSaved, onApproved,
}: Props) {
  const toast = useToast()
  const p = entry.payload

  const [value, setValue] = useState<string>(p.value === null ? '' : String(p.value))
  const [unit, setUnit] = useState(p.unit ?? '')
  const [commodity, setCommodity] = useState(p.commodity ?? '')
  const [geo, setGeo] = useState(p.geo ?? '')
  const [measure, setMeasure] = useState(p.measure ?? '')
  const [season, setSeason] = useState(p.season ?? '')
  const [source, setSource] = useState(p.source ?? '')
  const [note, setNote] = useState(p.note ?? '')
  const [geoQuery, setGeoQuery] = useState('')
  const [busy, setBusy] = useState(false)

  // Inline quick-add commodity
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const [newCommodityId, setNewCommodityId] = useState('')
  const [newCommodityName, setNewCommodityName] = useState('')
  const [localCommodities, setLocalCommodities] = useState<RefOption[]>(commodities)

  // Fuzzy geo search
  const geoMatches = useMemo(() => {
    const q = norm(geoQuery)
    if (!q) return geographies.slice(0, 8)
    return geographies
      .filter(g => norm(g.name).includes(q) || norm(g.id).includes(q))
      .slice(0, 8)
  }, [geoQuery, geographies])

  const errors: string[] = []
  if (!commodity) errors.push('Commodity is required (unmapped rows cannot be approved).')
  if (!geo) errors.push('Geography is required.')
  if (!measure.trim()) errors.push('Measure is required.')
  if (!season.trim()) errors.push('Season is required.')
  if (value.trim() === '' || !Number.isFinite(Number(value))) errors.push('A numeric value is required.')
  const valid = errors.length === 0

  const commodityName = localCommodities.find(c => c.id === commodity)?.name
  const geoName = geographies.find(g => g.id === geo)?.name

  function buildBody() {
    return {
      id: entry.id,
      value: value.trim() === '' ? null : Number(value),
      unit: unit.trim() || null,
      commodity: commodity || null,
      geo: geo || null,
      measure: measure.trim() || null,
      season: season.trim() || null,
      source: source.trim() || null,
      note: note.trim() || null,
      commodity_label: commodityName ?? p.commodity_label ?? null,
      geo_label: geoName ?? p.geo_label ?? null,
    }
  }

  async function save(): Promise<boolean> {
    setBusy(true)
    try {
      const res = await fetch('/api/markets/manage/review', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error ?? 'Save failed.'); return false }
      return true
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error.')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function onSave() {
    if (await save()) { toast.success('Changes saved.'); await onSaved() }
  }

  async function onSaveAndApprove() {
    if (!valid) { toast.error('Resolve the validation errors first.'); return }
    if (!(await save())) return
    setBusy(true)
    try {
      const res = await fetch('/api/markets/manage/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', ids: [entry.id] }),
      })
      const json = await res.json()
      if (!res.ok || json.failed > 0) {
        toast.error(json.error ?? (json.results?.[0]?.error) ?? 'Approval failed.')
      } else {
        toast.success('Saved and approved into the live dataset.')
        await onApproved()
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error.')
    } finally {
      setBusy(false)
    }
  }

  async function quickAddCommodity() {
    const id = newCommodityId.trim()
    const name = newCommodityName.trim()
    if (!id || !name) { toast.error('Both id and name are required.'); return }
    setBusy(true)
    try {
      const res = await fetch('/api/markets/manage/commodities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error ?? 'Quick-add failed.'); return }
      setLocalCommodities(prev => [...prev, { id, name }].sort((a, b) => a.name.localeCompare(b.name)))
      setCommodity(id)
      setQuickAddOpen(false)
      setNewCommodityId(''); setNewCommodityName('')
      toast.success(`Added commodity “${name}”.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-border bg-card p-4 shadow-xl sm:rounded-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Edit observation</h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3">
          {/* Commodity */}
          <Field label="Commodity" required unmapped={!commodity}>
            <div className="flex gap-2">
              <select
                value={commodity}
                onChange={e => setCommodity(e.target.value)}
                className={inputCls(!commodity)}
              >
                <option value="">— unmapped —</option>
                {localCommodities.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button
                type="button"
                onClick={() => setQuickAddOpen(v => !v)}
                className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" /> New
              </button>
            </div>
            {!commodity && p.suggestions?.commodity && (
              <SuggestionHint label={p.suggestions.commodity} onUse={() => setCommodity(p.suggestions!.commodity!)} />
            )}
            {quickAddOpen && (
              <div className="mt-2 space-y-2 rounded-md border border-dashed border-border p-2">
                <div className="grid grid-cols-2 gap-2">
                  <input value={newCommodityId} onChange={e => setNewCommodityId(e.target.value)} placeholder="id (e.g. papaya)" className={inputCls(false)} />
                  <input value={newCommodityName} onChange={e => setNewCommodityName(e.target.value)} placeholder="Name" className={inputCls(false)} />
                </div>
                <button type="button" onClick={quickAddCommodity} disabled={busy} className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50">
                  Add commodity
                </button>
              </div>
            )}
          </Field>

          {/* Geography with fuzzy picker */}
          <Field label="Geography" required unmapped={!geo}>
            <select value={geo} onChange={e => setGeo(e.target.value)} className={inputCls(!geo)}>
              <option value="">— unmapped —</option>
              {geographies.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            {!geo && (
              <div className="mt-2">
                <input
                  value={geoQuery}
                  onChange={e => setGeoQuery(e.target.value)}
                  placeholder="Fuzzy search geography…"
                  className={inputCls(false)}
                />
                {geoQuery && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {geoMatches.length === 0 && <span className="text-xs text-muted-foreground">No matches.</span>}
                    {geoMatches.map(g => (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => { setGeo(g.id); setGeoQuery('') }}
                        className="rounded-full border border-border px-2 py-0.5 text-xs hover:bg-accent"
                      >
                        {g.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {!geo && p.suggestions?.geo && (
              <SuggestionHint label={p.suggestions.geo} onUse={() => setGeo(p.suggestions!.geo!)} />
            )}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Value" required>
              <input value={value} onChange={e => setValue(e.target.value)} inputMode="decimal" className={inputCls(false)} />
            </Field>
            <Field label="Unit">
              <input value={unit} onChange={e => setUnit(e.target.value)} className={inputCls(false)} />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Measure" required>
              <input value={measure} onChange={e => setMeasure(e.target.value)} className={inputCls(false)} />
            </Field>
            <Field label="Season" required>
              <input value={season} onChange={e => setSeason(e.target.value)} className={inputCls(false)} />
            </Field>
          </div>

          <Field label="Source">
            <select value={source} onChange={e => setSource(e.target.value)} className={inputCls(false)}>
              <option value="">Unspecified</option>
              {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>

          <Field label="Notes">
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} className={inputCls(false)} />
          </Field>

          {/* Live comparison */}
          {entry.comparison.live && (
            <div className={cn(
              'rounded-md border p-2 text-xs',
              entry.comparison.largeDiff || entry.comparison.confidenceMismatch
                ? 'border-destructive/40 bg-destructive/5 text-destructive'
                : 'border-border bg-muted/40 text-muted-foreground',
            )}>
              Current live figure: <span className="font-mono">{entry.comparison.live.value}{entry.comparison.live.unit ? ` ${entry.comparison.live.unit}` : ''}</span>
              {entry.comparison.percentDiff !== null && <> · diff {entry.comparison.percentDiff.toFixed(0)}%</>}
              {(entry.comparison.largeDiff || entry.comparison.confidenceMismatch) && (
                <span className="ml-1 inline-flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> review carefully</span>
              )}
            </div>
          )}

          {!valid && (
            <ul className="space-y-0.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400">
              {errors.map(e => <li key={e}>• {e}</li>)}
            </ul>
          )}
        </div>

        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent">
            Cancel
          </button>
          <button type="button" onClick={onSave} disabled={busy} className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50">
            Save
          </button>
          <button
            type="button"
            onClick={onSaveAndApprove}
            disabled={busy || !valid}
            className="flex items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Save &amp; approve
          </button>
        </div>
      </div>
    </div>
  )
}

function inputCls(invalid: boolean): string {
  return cn(
    'w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring',
    invalid ? 'border-amber-500/60' : 'border-input',
  )
}

function Field({ label, required, unmapped, children }: { label: string; required?: boolean; unmapped?: boolean; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        {label}{required && <span className="text-destructive">*</span>}
        {unmapped && <AlertTriangle className="h-3 w-3 text-amber-500" />}
      </span>
      {children}
    </label>
  )
}

function SuggestionHint({ label, onUse }: { label: string; onUse: () => void }) {
  return (
    <button type="button" onClick={onUse} className="mt-1 text-xs text-primary hover:underline">
      Suggested: {label} — use it
    </button>
  )
}
