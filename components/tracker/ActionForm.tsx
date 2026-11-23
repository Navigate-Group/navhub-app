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
import type { Option, Person } from '@/components/tracker/MilestoneForm'

export type ActionValues = {
  title: string
  type: string
  who: string
  assignee_id: string
  due_on: string
  status: string
  priority: string
  milestone_id: string
  notes: string
}

const selectClass = cn(
  'h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm',
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
)

const STATUS_OPTIONS: Option[] = [
  { key: 'open', label: 'Open' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'done', label: 'Done' },
]

/**
 * Add / edit an action (P6) in a dialog. The database is the guard (082): edit
 * access on the plan (or editor for a plan-less action) to add or change.
 * Refusals show as a clear message.
 */
export default function ActionForm({
  open,
  onOpenChange,
  mode,
  planId,
  actionId,
  initial,
  types,
  priorities,
  people,
  milestones,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'new' | 'edit'
  planId: string
  actionId?: string
  initial: ActionValues
  types: Option[]
  priorities: Option[]
  people: Person[]
  milestones: { id: string; title: string }[]
}) {
  const router = useRouter()
  const [v, setV] = useState<ActionValues>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof ActionValues>(key: K, value: ActionValues[K]) {
    setV((prev) => ({ ...prev, [key]: value }))
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!v.title.trim()) return setError('An action title is required')
    setSaving(true)
    setError(null)

    const payload: Record<string, unknown> = {
      title: v.title,
      type: v.type || null,
      who: v.who || null,
      assignee_id: v.assignee_id || null,
      due_on: v.due_on || null,
      status: v.status || 'open',
      priority: v.priority || 'normal',
      milestone_id: v.milestone_id || null,
      notes: v.notes || null,
    }
    if (mode === 'new') payload.plan_id = planId

    try {
      const res =
        mode === 'new'
          ? await fetch('/api/tracker/actions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            })
          : await fetch(`/api/tracker/actions/${actionId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || 'Could not save the action')
        setSaving(false)
        return
      }
      onOpenChange(false)
      router.refresh()
    } catch {
      setError('Could not save the action')
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === 'new' ? 'Add action' : 'Edit action'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="a-title">Title *</Label>
            <Input id="a-title" value={v.title} onChange={(e) => set('title', e.target.value)} required />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="a-type">Type</Label>
              <select id="a-type" className={selectClass} value={v.type} onChange={(e) => set('type', e.target.value)}>
                <option value="">—</option>
                {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="a-who">Who it&apos;s with</Label>
              <Input id="a-who" value={v.who} onChange={(e) => set('who', e.target.value)} placeholder="e.g. someone outside the group" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="a-assignee">Assigned to</Label>
              <select id="a-assignee" className={selectClass} value={v.assignee_id} onChange={(e) => set('assignee_id', e.target.value)}>
                <option value="">—</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="a-due">Due date</Label>
              <Input id="a-due" type="date" value={v.due_on} onChange={(e) => set('due_on', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="a-status">Status</Label>
              <select id="a-status" className={selectClass} value={v.status} onChange={(e) => set('status', e.target.value)}>
                {STATUS_OPTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="a-priority">Priority</Label>
              <select id="a-priority" className={selectClass} value={v.priority} onChange={(e) => set('priority', e.target.value)}>
                {priorities.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="a-milestone">Milestone</Label>
            <select id="a-milestone" className={selectClass} value={v.milestone_id} onChange={(e) => set('milestone_id', e.target.value)}>
              <option value="">None</option>
              {milestones.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
            </select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="a-notes">Notes</Label>
            <textarea
              id="a-notes"
              rows={3}
              className={cn(
                'w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              )}
              value={v.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : mode === 'new' ? 'Add action' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
