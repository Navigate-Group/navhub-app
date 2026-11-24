'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export type Option = { key: string; label: string }
export type Person = { id: string; name: string }

export type MilestoneValues = {
  title: string
  description: string
  owner_id: string
  status: string
  health: string
  start_on: string
  due_on: string
  baseline_due_on: string
  priority: string
  progress_mode: 'manual' | 'from_actions'
  progress_pct: number
}

const selectClass = cn(
  'h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm',
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
)

const HEALTH_OPTIONS: Option[] = [
  { key: 'on_track', label: 'On track' },
  { key: 'at_risk', label: 'At risk' },
  { key: 'off_track', label: 'Off track' },
]

/**
 * Add / edit a milestone (P6) in a dialog. The database is the guard (082/085):
 * edit access on the plan to add or change; only the milestone's owner or a
 * Manager may move the original due date (baseline). Refusals show as a clear
 * message. `canEditBaseline` only decides whether the baseline field is editable
 * here — the DB still enforces.
 */
export default function MilestoneForm({
  open,
  onOpenChange,
  mode,
  planId,
  milestoneId,
  initial,
  statuses,
  priorities,
  people,
  canEditBaseline,
  currentStatusLabel,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'new' | 'edit'
  planId: string
  milestoneId?: string
  initial: MilestoneValues
  statuses: Option[]
  priorities: Option[]
  people: Person[]
  canEditBaseline: boolean
  // This milestone's current status label, used only when that status is a now-
  // hidden lookup value so it still shows in the picker (falls back to the key).
  currentStatusLabel?: string
}) {
  const router = useRouter()
  const [v, setV] = useState<MilestoneValues>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof MilestoneValues>(key: K, value: MilestoneValues[K]) {
    setV((prev) => ({ ...prev, [key]: value }))
  }

  // Keep this milestone's own current status in the picker even if it's now a
  // hidden lookup value, so it shows and isn't silently cleared on save. Other
  // (new/unset) records don't get the extra option.
  const statusOptions =
    initial.status && !statuses.some((s) => s.key === initial.status)
      ? [...statuses, { key: initial.status, label: currentStatusLabel || initial.status }]
      : statuses

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!v.title.trim()) return setError('A milestone title is required')
    setSaving(true)
    setError(null)

    const payload: Record<string, unknown> = {
      title: v.title,
      description: v.description || null,
      owner_id: v.owner_id || null,
      status: v.status || 'backlog',
      health: v.health || 'on_track',
      start_on: v.start_on || null,
      due_on: v.due_on || null,
      priority: v.priority || 'normal',
      progress_mode: v.progress_mode,
      progress_pct: v.progress_mode === 'from_actions' ? 0 : v.progress_pct,
    }
    if (mode === 'new') payload.plan_id = planId
    // Only send the baseline on an edit when the user may change it and it moved.
    if (mode === 'edit' && canEditBaseline && v.baseline_due_on !== initial.baseline_due_on) {
      payload.baseline_due_on = v.baseline_due_on || null
    }

    try {
      const res =
        mode === 'new'
          ? await fetch('/api/tracker/milestones', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            })
          : await fetch(`/api/tracker/milestones/${milestoneId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || 'Could not save the milestone')
        setSaving(false)
        return
      }
      onOpenChange(false)
      router.refresh()
    } catch {
      setError('Could not save the milestone')
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === 'new' ? 'Add milestone' : 'Edit milestone'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="m-title">Title *</Label>
            <Input id="m-title" value={v.title} onChange={(e) => set('title', e.target.value)} required />
          </div>

          <div className="space-y-1">
            <Label htmlFor="m-description">Description</Label>
            <textarea
              id="m-description"
              rows={3}
              className={cn(
                'w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              )}
              value={v.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="m-owner">Owner</Label>
              <select id="m-owner" className={selectClass} value={v.owner_id} onChange={(e) => set('owner_id', e.target.value)}>
                <option value="">—</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="m-status">Status</Label>
              <select id="m-status" className={selectClass} value={v.status} onChange={(e) => set('status', e.target.value)}>
                {statusOptions.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="m-health">Health</Label>
              <select id="m-health" className={selectClass} value={v.health} onChange={(e) => set('health', e.target.value)}>
                {HEALTH_OPTIONS.map((h) => <option key={h.key} value={h.key}>{h.label}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="m-priority">Priority</Label>
              <select id="m-priority" className={selectClass} value={v.priority} onChange={(e) => set('priority', e.target.value)}>
                {priorities.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="m-start">Start date</Label>
              <Input id="m-start" type="date" value={v.start_on} onChange={(e) => set('start_on', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="m-due">Due date</Label>
              <Input id="m-due" type="date" value={v.due_on} onChange={(e) => set('due_on', e.target.value)} />
            </div>
          </div>

          {mode === 'edit' && (
            <div className="space-y-1">
              <Label htmlFor="m-baseline">Original due date</Label>
              <Input
                id="m-baseline"
                type="date"
                value={v.baseline_due_on}
                onChange={(e) => set('baseline_due_on', e.target.value)}
                disabled={!canEditBaseline}
              />
              <p className="text-xs text-muted-foreground">
                Days slipped is measured against this.
                {!canEditBaseline && ' Only the milestone’s owner or a Manager can change it.'}
              </p>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="m-progress-mode">Progress</Label>
              <select
                id="m-progress-mode"
                className={selectClass}
                value={v.progress_mode}
                onChange={(e) => set('progress_mode', e.target.value as MilestoneValues['progress_mode'])}
              >
                <option value="from_actions">Worked out from its actions</option>
                <option value="manual">A percentage I type</option>
              </select>
            </div>
            {v.progress_mode === 'manual' && (
              <div className="space-y-1">
                <Label htmlFor="m-progress-pct">Progress (%)</Label>
                <Input
                  id="m-progress-pct"
                  type="number"
                  min={0}
                  max={100}
                  value={v.progress_pct}
                  onChange={(e) => set('progress_pct', Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                />
              </div>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : mode === 'new' ? 'Add milestone' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
