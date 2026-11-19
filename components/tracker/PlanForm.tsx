'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export type PlanFormOption = { key: string; label: string }
export type PlanFormPerson = { id: string; name: string }

export type PlanFormValues = {
  name: string
  category: string
  status: string
  client: string
  phase: string
  summary: string
  folder: string
  parent_id: string
  region: string
  start_on: string
  end_on: string
  priority: string
  progress_pct: number
  owner_id: string
  lead_id: string
  /** Member user ids (role = 'member'). The lead is kept in lead_id. */
  member_ids: string[]
}

const selectClass = cn(
  'h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm',
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
)

/**
 * Create / edit a project (P5). The server validates and the database is the
 * guard; refusals are shown as a clear message. Owner/lead pickers and some
 * controls are gated by `isEditor` (convenience only — the DB enforces).
 */
export default function PlanForm({
  mode,
  planId,
  initial,
  categories,
  statuses,
  regions,
  priorities,
  parentOptions,
  people,
  managers,
  isEditor,
  canEditMembers = isEditor,
}: {
  mode: 'new' | 'edit'
  planId?: string
  initial: PlanFormValues
  categories: PlanFormOption[]
  statuses: PlanFormOption[]
  regions: PlanFormOption[]
  priorities: PlanFormOption[]
  parentOptions: { id: string; name: string }[]
  people: PlanFormPerson[]
  managers: PlanFormPerson[]
  isEditor: boolean
  /** Only Managers/Group Owners can change members (the DB enforces too). */
  canEditMembers?: boolean
}) {
  const router = useRouter()
  const [v, setV] = useState<PlanFormValues>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof PlanFormValues>(key: K, value: PlanFormValues[K]) {
    setV((prev) => ({ ...prev, [key]: value }))
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!v.name.trim()) return setError('A project name is required')
    if (!v.category) return setError('A category is required')
    setSaving(true)
    setError(null)

    const payload: Record<string, unknown> = {
      name: v.name,
      category: v.category,
      status: v.status || null,
      client: v.client || null,
      phase: v.phase || null,
      summary: v.summary || null,
      folder: v.folder || null,
      parent_id: v.parent_id || null,
      region: v.region || null,
      start_on: v.start_on || null,
      end_on: v.end_on || null,
      priority: v.priority || 'normal',
      progress_pct: v.progress_pct,
      lead_id: v.lead_id || null,
    }
    // Only editors can set the owner; otherwise the server defaults it.
    if (isEditor) payload.owner_id = v.owner_id || null
    // Only Managers/Group Owners can change members (the DB enforces too). When
    // allowed, send the chosen member ids; the server writes the difference.
    if (canEditMembers) payload.member_ids = v.member_ids

    try {
      const res =
        mode === 'new'
          ? await fetch('/api/tracker/plans', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            })
          : await fetch(`/api/tracker/plans/${planId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || 'Could not save the project')
        setSaving(false)
        return
      }
      const id = mode === 'new' ? body.data?.id : planId
      router.push(id ? `/tracker/plans/${id}` : '/tracker/plans')
      router.refresh()
    } catch {
      setError('Could not save the project')
      setSaving(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-4">
      <div className="space-y-1">
        <Label htmlFor="name">Name *</Label>
        <Input id="name" value={v.name} onChange={(e) => set('name', e.target.value)} required />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="category">Category *</Label>
          <select id="category" className={selectClass} value={v.category} onChange={(e) => set('category', e.target.value)} required>
            <option value="">—</option>
            {categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="status">Status</Label>
          <select id="status" className={selectClass} value={v.status} onChange={(e) => set('status', e.target.value)}>
            <option value="">—</option>
            {statuses.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="client">Client</Label>
          <Input id="client" value={v.client} onChange={(e) => set('client', e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="phase">Phase</Label>
          <Input id="phase" value={v.phase} onChange={(e) => set('phase', e.target.value)} />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="summary">Summary</Label>
        <textarea
          id="summary"
          rows={4}
          className={cn('w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring')}
          value={v.summary}
          onChange={(e) => set('summary', e.target.value)}
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="folder">Folder</Label>
        <Input id="folder" value={v.folder} onChange={(e) => set('folder', e.target.value)} placeholder="https://…" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="parent">Parent project</Label>
          <select id="parent" className={selectClass} value={v.parent_id} onChange={(e) => set('parent_id', e.target.value)}>
            <option value="">None (top-level)</option>
            {parentOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="region">Region</Label>
          <select id="region" className={selectClass} value={v.region} onChange={(e) => set('region', e.target.value)}>
            <option value="">—</option>
            {regions.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="start">Start date</Label>
          <Input id="start" type="date" value={v.start_on} onChange={(e) => set('start_on', e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="end">End date</Label>
          <Input id="end" type="date" value={v.end_on} onChange={(e) => set('end_on', e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="priority">Priority</Label>
          <select id="priority" className={selectClass} value={v.priority} onChange={(e) => set('priority', e.target.value)}>
            {priorities.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="progress">Progress (%)</Label>
          <Input
            id="progress"
            type="number"
            min={0}
            max={100}
            value={v.progress_pct}
            onChange={(e) => set('progress_pct', Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
          />
        </div>
        {isEditor && (
          <div className="space-y-1">
            <Label htmlFor="owner">Owner</Label>
            <select id="owner" className={selectClass} value={v.owner_id} onChange={(e) => set('owner_id', e.target.value)}>
              <option value="">—</option>
              {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="lead">Lead</Label>
          <select id="lead" className={selectClass} value={v.lead_id} onChange={(e) => set('lead_id', e.target.value)}>
            <option value="">—</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>

      {/* Members */}
      <MembersField
        memberIds={v.member_ids}
        people={people}
        canEdit={canEditMembers}
        onChange={(ids) => set('member_ids', ids)}
      />

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>{saving ? 'Saving…' : mode === 'new' ? 'Create project' : 'Save changes'}</Button>
        <Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button>
      </div>
    </form>
  )
}

/**
 * The Members field: chosen members as removable chips plus an "Add a member…"
 * picker of the other group members. Managers/Group Owners can change it; for
 * everyone else the members show as plain text (the DB is the real guard).
 */
function MembersField({
  memberIds,
  people,
  canEdit,
  onChange,
}: {
  memberIds: string[]
  people: PlanFormPerson[]
  canEdit: boolean
  onChange: (ids: string[]) => void
}) {
  const nameById = (id: string) => people.find((p) => p.id === id)?.name ?? '—'
  const chosen = memberIds.filter((id) => people.some((p) => p.id === id))
  const available = people.filter((p) => !memberIds.includes(p.id))

  if (!canEdit) {
    return (
      <div className="space-y-1">
        <Label>Members</Label>
        <p className="text-sm">
          {chosen.length === 0 ? '—' : chosen.map(nameById).join(', ')}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <Label htmlFor="member-picker">Members</Label>
      <div className="flex flex-wrap items-center gap-2">
        {chosen.map((id) => (
          <span
            key={id}
            className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-sm"
          >
            {nameById(id)}
            <button
              type="button"
              onClick={() => onChange(memberIds.filter((m) => m !== id))}
              aria-label={`Remove ${nameById(id)}`}
              className="rounded-full px-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              ×
            </button>
          </span>
        ))}
        <select
          id="member-picker"
          className={cn(selectClass, 'h-9 w-auto min-w-[12rem]')}
          value=""
          onChange={(e) => {
            const id = e.target.value
            if (id && !memberIds.includes(id)) onChange([...memberIds, id])
          }}
          disabled={available.length === 0}
          aria-label="Add a member"
        >
          <option value="">Add a member…</option>
          {available.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        The people working on this project. Being a member doesn&apos;t give edit
        rights: that comes from the person&apos;s role or the project access a
        Manager gives.
      </p>
    </div>
  )
}
