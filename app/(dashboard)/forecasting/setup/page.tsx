'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ChevronRight, Plus, Pencil, Trash2, ChevronUp, ChevronDown, X, AlertTriangle } from 'lucide-react'
import { Button }  from '@/components/ui/button'
import { Badge }   from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils'
import type { ForecastStream, NumberFormat } from '@/lib/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface StreamFormState {
  name:                string
  tag:                 string
  color:               string
  y1_dollars:          string   // displayed as dollars, stored as cents
  default_growth_rate: string
  default_gp_margin:   string
}

const EMPTY_FORM: StreamFormState = {
  name:                '',
  tag:                 'Revenue',
  color:               '#4ade80',
  y1_dollars:          '0',
  default_growth_rate: '20',
  default_gp_margin:   '40',
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function StreamSetupPage() {
  const [streams,     setStreams]     = useState<ForecastStream[]>([])
  const [loading,     setLoading]     = useState(true)
  const [isAdmin,     setIsAdmin]     = useState(false)
  const [prefs,       setPrefs]       = useState({ number_format: 'thousands' as NumberFormat, currency: 'AUD' })

  // Add form
  const [showAddForm, setShowAddForm] = useState(false)
  const [addForm,     setAddForm]     = useState<StreamFormState>(EMPTY_FORM)
  const [addSaving,   setAddSaving]   = useState(false)
  const [addError,    setAddError]    = useState<string | null>(null)

  // Edit state — one stream at a time
  const [editId,      setEditId]      = useState<string | null>(null)
  const [editForm,    setEditForm]    = useState<StreamFormState>(EMPTY_FORM)
  const [editSaving,  setEditSaving]  = useState(false)
  const [editError,   setEditError]   = useState<string | null>(null)

  // Delete confirm
  const [deleteId,    setDeleteId]    = useState<string | null>(null)
  const [deleting,    setDeleting]    = useState(false)

  // ── Load ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    Promise.all([
      fetch('/api/forecast/streams').then(r => r.json()),
      fetch('/api/groups/active').then(r => r.json()),
      fetch('/api/settings').then(r => r.json()),
    ]).then(([streamsJson, groupJson, prefsJson]) => {
      setStreams(streamsJson.data ?? [])
      const role = groupJson.data?.role ?? ''
      setIsAdmin(role === 'super_admin' || role === 'group_owner' || role === 'group_admin')
      if (prefsJson.data) setPrefs(prefsJson.data)
    }).finally(() => setLoading(false))
  }, [])

  // ── Helpers ───────────────────────────────────────────────────────────────

  const fmt = (cents: number) =>
    formatCurrency(cents, prefs.number_format, prefs.currency)

  function formToPayload(form: StreamFormState) {
    return {
      name:                form.name.trim(),
      tag:                 form.tag.trim() || 'Revenue',
      color:               form.color,
      y1_baseline:         Math.round(parseFloat(form.y1_dollars || '0') * 100),
      default_growth_rate: Math.max(0, Math.min(120, parseInt(form.default_growth_rate) || 0)),
      default_gp_margin:   Math.max(0, Math.min(100, parseInt(form.default_gp_margin) || 0)),
    }
  }

  function streamToForm(s: ForecastStream): StreamFormState {
    return {
      name:                s.name,
      tag:                 s.tag,
      color:               s.color,
      y1_dollars:          String(s.y1_baseline / 100),
      default_growth_rate: String(s.default_growth_rate),
      default_gp_margin:   String(s.default_gp_margin),
    }
  }

  function validateForm(form: StreamFormState): string | null {
    if (!form.name.trim()) return 'Stream name is required'
    const dollars = parseFloat(form.y1_dollars)
    if (isNaN(dollars)) return 'Y1 baseline must be a number'
    const gr = parseInt(form.default_growth_rate)
    if (isNaN(gr) || gr < 0 || gr > 120) return 'Growth rate must be 0–120%'
    const gp = parseInt(form.default_gp_margin)
    if (isNaN(gp) || gp < 0 || gp > 100) return 'GP margin must be 0–100%'
    return null
  }

  // ── Add stream ────────────────────────────────────────────────────────────

  async function handleAdd() {
    const err = validateForm(addForm)
    if (err) { setAddError(err); return }
    setAddSaving(true)
    setAddError(null)
    try {
      const res  = await fetch('/api/forecast/streams', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(formToPayload(addForm)),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to create stream')
      setStreams(prev => [...prev, json.data])
      setAddForm(EMPTY_FORM)
      setShowAddForm(false)
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Failed to create stream')
    } finally {
      setAddSaving(false)
    }
  }

  // ── Edit stream ───────────────────────────────────────────────────────────

  function startEdit(stream: ForecastStream) {
    setEditId(stream.id)
    setEditForm(streamToForm(stream))
    setEditError(null)
  }

  async function handleSaveEdit() {
    if (!editId) return
    const err = validateForm(editForm)
    if (err) { setEditError(err); return }
    setEditSaving(true)
    setEditError(null)
    try {
      const res  = await fetch(`/api/forecast/streams/${editId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(formToPayload(editForm)),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to save')
      setStreams(prev => prev.map(s => s.id === editId ? json.data : s))
      setEditId(null)
    } catch (e) {
      setEditError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setEditSaving(false)
    }
  }

  // ── Delete stream ─────────────────────────────────────────────────────────

  async function handleDelete(id: string) {
    setDeleting(true)
    try {
      const res = await fetch(`/api/forecast/streams/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete')
      setStreams(prev => prev.filter(s => s.id !== id))
      setDeleteId(null)
    } catch {
      // keep confirm open so user sees failure
    } finally {
      setDeleting(false)
    }
  }

  // ── Reorder ───────────────────────────────────────────────────────────────

  async function handleMove(index: number, direction: 'up' | 'down') {
    const targetIndex = direction === 'up' ? index - 1 : index + 1
    if (targetIndex < 0 || targetIndex >= streams.length) return

    const a = streams[index]
    const b = streams[targetIndex]

    // Optimistic update
    const next = [...streams]
    next[index]       = { ...b, sort_order: a.sort_order }
    next[targetIndex] = { ...a, sort_order: b.sort_order }
    next.sort((x, y) => x.sort_order - y.sort_order)
    setStreams(next)

    // Persist
    await Promise.all([
      fetch(`/api/forecast/streams/${a.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sort_order: b.sort_order }),
      }),
      fetch(`/api/forecast/streams/${b.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sort_order: a.sort_order }),
      }),
    ])
  }

  // ── Form component ────────────────────────────────────────────────────────

  function StreamForm({
    form,
    onChange,
    onSave,
    onCancel,
    saving,
    error,
    saveLabel = 'Save',
  }: {
    form:      StreamFormState
    onChange:  (f: StreamFormState) => void
    onSave:    () => void
    onCancel:  () => void
    saving:    boolean
    error:     string | null
    saveLabel?: string
  }) {
    return (
      <div className="space-y-4 pt-2">
        {error && (
          <div className="flex items-center gap-2 text-sm text-destructive rounded-md bg-destructive/5 border border-destructive/20 px-3 py-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error}
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Name */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Stream name *</label>
            <input
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              value={form.name}
              onChange={e => onChange({ ...form, name: e.target.value })}
              placeholder="e.g. SaaS Subscriptions"
            />
          </div>
          {/* Tag */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Tag</label>
            <input
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              value={form.tag}
              onChange={e => onChange({ ...form, tag: e.target.value })}
              placeholder="e.g. Recurring, One-off"
            />
          </div>
          {/* Colour */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Colour</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                className="h-9 w-14 rounded-md border border-input bg-background cursor-pointer"
                value={form.color}
                onChange={e => onChange({ ...form, color: e.target.value })}
              />
              <span className="text-xs font-mono text-muted-foreground">{form.color}</span>
            </div>
          </div>
          {/* Y1 Baseline */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Starting position (prior year actual or 0) *</label>
            <div className="flex items-center">
              <span className="h-9 px-3 flex items-center rounded-l-md border border-r-0 border-input bg-muted text-sm text-muted-foreground">$</span>
              <input
                type="number"
                step="1"
                min="0"
                className="flex-1 h-9 rounded-l-none rounded-r-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                value={form.y1_dollars}
                onChange={e => onChange({ ...form, y1_dollars: e.target.value })}
                placeholder="0"
              />
            </div>
          </div>
          {/* Growth rate */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Default annual growth rate %</label>
            <div className="flex items-center">
              <input
                type="number"
                step="1"
                min="0"
                max="120"
                className="flex-1 h-9 rounded-l-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                value={form.default_growth_rate}
                onChange={e => onChange({ ...form, default_growth_rate: e.target.value })}
              />
              <span className="h-9 px-3 flex items-center rounded-r-md border border-l-0 border-input bg-muted text-sm text-muted-foreground">%</span>
            </div>
          </div>
          {/* GP margin */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Default GP margin %</label>
            <div className="flex items-center">
              <input
                type="number"
                step="1"
                min="0"
                max="100"
                className="flex-1 h-9 rounded-l-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                value={form.default_gp_margin}
                onChange={e => onChange({ ...form, default_gp_margin: e.target.value })}
              />
              <span className="h-9 px-3 flex items-center rounded-r-md border border-l-0 border-input bg-muted text-sm text-muted-foreground">%</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Button size="sm" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : saveLabel}
          </Button>
          <Button size="sm" variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-8 bg-muted rounded w-48" />
        <div className="h-4 bg-muted rounded w-72" />
        <div className="h-24 bg-muted rounded" />
        <div className="h-24 bg-muted rounded" />
      </div>
    )
  }

  return (
    <div className="space-y-5 max-w-3xl">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1 text-xs text-muted-foreground">
        <Link href="/dashboard" className="hover:text-foreground transition-colors">Dashboard</Link>
        <ChevronRight className="h-3 w-3" />
        <Link href="/forecasting/revenue" className="hover:text-foreground transition-colors">Forecasting</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">Revenue Streams</span>
      </nav>

      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Revenue Streams</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Configure forecast streams for this group
          </p>
        </div>
        {isAdmin && !showAddForm && (
          <Button size="sm" onClick={() => { setShowAddForm(true); setAddForm(EMPTY_FORM); setAddError(null) }}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Stream
          </Button>
        )}
      </div>

      {/* Non-admin notice */}
      {!isAdmin && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 px-4 py-2.5 text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Only group admins can create or edit revenue streams.</span>
        </div>
      )}

      {/* Add form */}
      {showAddForm && isAdmin && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium">New stream</p>
            <button onClick={() => setShowAddForm(false)} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
          <StreamForm
            form={addForm}
            onChange={setAddForm}
            onSave={handleAdd}
            onCancel={() => { setShowAddForm(false); setAddError(null) }}
            saving={addSaving}
            error={addError}
            saveLabel="Create stream"
          />
        </div>
      )}

      {/* Stream list */}
      {streams.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground rounded-lg border border-dashed">
          <p className="text-sm font-medium mb-1">No revenue streams yet</p>
          <p className="text-xs text-center max-w-xs">
            {isAdmin
              ? 'Click "Add Stream" to create your first revenue stream.'
              : 'Ask a group admin to configure revenue streams.'}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden divide-y">
          {streams.map((stream, index) => (
            <div key={stream.id}>
              {/* Stream row */}
              {editId !== stream.id ? (
                <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors">
                  {/* Colour dot */}
                  <div className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: stream.color }} />

                  {/* Name + tag */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{stream.name}</span>
                      <Badge variant="secondary" className="text-[10px]">{stream.tag}</Badge>
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="hidden sm:flex items-center gap-4 text-xs text-muted-foreground shrink-0">
                    <span>Y1: <span className="font-medium text-foreground">{fmt(stream.y1_baseline)}</span></span>
                    <span>Gr: <span className="font-medium text-foreground">{stream.default_growth_rate}%</span></span>
                    <span>GP: <span className="font-medium text-foreground">{stream.default_gp_margin}%</span></span>
                  </div>

                  {/* Actions */}
                  {isAdmin && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleMove(index, 'up')}
                        disabled={index === 0}
                        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed"
                        title="Move up"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => handleMove(index, 'down')}
                        disabled={index === streams.length - 1}
                        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed"
                        title="Move down"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => startEdit(stream)}
                        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
                        title="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setDeleteId(stream.id)}
                        className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                /* Edit form */
                <div className="px-4 py-3 bg-muted/20">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium">Edit: {stream.name}</p>
                    <button onClick={() => setEditId(null)} className="text-muted-foreground hover:text-foreground">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <StreamForm
                    form={editForm}
                    onChange={setEditForm}
                    onSave={handleSaveEdit}
                    onCancel={() => { setEditId(null); setEditError(null) }}
                    saving={editSaving}
                    error={editError}
                  />
                </div>
              )}

              {/* Delete confirm */}
              {deleteId === stream.id && (
                <div className="flex items-center gap-3 px-4 py-2.5 bg-destructive/5 border-t border-destructive/20">
                  <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
                  <span className="text-sm text-destructive flex-1">
                    Delete &ldquo;{stream.name}&rdquo;? This cannot be undone.
                  </span>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => handleDelete(stream.id)}
                    disabled={deleting}
                  >
                    {deleting ? 'Deleting…' : 'Delete'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDeleteId(null)}
                    disabled={deleting}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Link to forecast model */}
      {streams.length > 0 && (
        <div className="pt-2">
          <Link href="/forecasting/revenue" className="text-sm text-primary hover:underline flex items-center gap-1">
            View revenue model <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}
    </div>
  )
}
