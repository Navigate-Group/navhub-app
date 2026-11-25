'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ChevronUp, ChevronDown, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleSwitch } from '@/components/ui/toggle-switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export type SettingsValues = {
  chaser_days: number
  stale_days: number
  contact_followup_days: number
  review_day: string
  week_start: string
  time_zone: string
}

export type SettingsLookupRow = {
  id: string
  list: string
  key: string
  label: string
  sort_order: number
  active: boolean
}

/** A project that has sub-projects, with how many it has. */
export type ParentProjectRow = {
  id: string
  name: string
  subCount: number
}

/** A simple { key, label } choice for the category and region dropdowns. */
export type SettingsOption = { key: string; label: string }

const selectClass = cn(
  'h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm',
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
)

// The seven lists, in the order the picker offers them, with friendly names.
const LISTS: { list: string; label: string }[] = [
  { list: 'status', label: 'Plan status' },
  { list: 'category', label: 'Category' },
  { list: 'milestone_status', label: 'Milestone status' },
  { list: 'action_type', label: 'Action type' },
  { list: 'source', label: 'Update source' },
  { list: 'region', label: 'Region' },
  { list: 'review_step', label: 'Review steps' },
]

const REVIEW_DAYS = [
  { key: 'monday', label: 'Monday' },
  { key: 'tuesday', label: 'Tuesday' },
  { key: 'wednesday', label: 'Wednesday' },
  { key: 'thursday', label: 'Thursday' },
  { key: 'friday', label: 'Friday' },
  { key: 'saturday', label: 'Saturday' },
  { key: 'sunday', label: 'Sunday' },
]

const WEEK_STARTS = [
  { key: 'monday', label: 'Monday' },
  { key: 'sunday', label: 'Sunday' },
]

const TIME_ZONES = [
  { key: 'Australia/Perth', label: 'Perth' },
  { key: 'Australia/Darwin', label: 'Darwin' },
  { key: 'Australia/Adelaide', label: 'Adelaide' },
  { key: 'Australia/Brisbane', label: 'Brisbane' },
  { key: 'Australia/Sydney', label: 'Sydney' },
  { key: 'Australia/Melbourne', label: 'Melbourne' },
  { key: 'Australia/Hobart', label: 'Hobart' },
]

export default function TrackerSettings({
  settings,
  lookups,
  parentProjects,
  categories,
  regions,
}: {
  settings: SettingsValues
  lookups: SettingsLookupRow[]
  parentProjects: ParentProjectRow[]
  categories: SettingsOption[]
  regions: SettingsOption[]
}) {
  return (
    <div className="max-w-3xl space-y-6">
      <ThresholdsForm initial={settings} />
      <ParentProjectsCard initial={parentProjects} categories={categories} regions={regions} />
      <ListsManager initial={lookups} />
    </div>
  )
}

/** A titled box that groups related fields (matches PlanForm's design). */
function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>
}

// ── Thresholds + calendar ────────────────────────────────────────────────────

function ThresholdsForm({ initial }: { initial: SettingsValues }) {
  const router = useRouter()
  const [v, setV] = useState<SettingsValues>(initial)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) {
    setV((prev) => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  function clampDays(raw: string): number {
    const n = Math.round(Number(raw) || 0)
    return Math.max(1, Math.min(365, n))
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const res = await fetch('/api/tracker/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(v),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || 'Could not save the settings')
        setSaving(false)
        return
      }
      setSaved(true)
      setSaving(false)
      router.refresh()
    } catch {
      setError('Could not save the settings')
      setSaving(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <FormSection title="Reminders">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="chaser_days">Waiting chaser (days)</Label>
            <Input
              id="chaser_days"
              type="number"
              min={1}
              max={365}
              value={v.chaser_days}
              onChange={(e) => set('chaser_days', clampDays(e.target.value))}
            />
            <FieldHint>Nudge after this many days waiting on others.</FieldHint>
          </div>
          <div className="space-y-1">
            <Label htmlFor="stale_days">Stale after (days)</Label>
            <Input
              id="stale_days"
              type="number"
              min={1}
              max={365}
              value={v.stale_days}
              onChange={(e) => set('stale_days', clampDays(e.target.value))}
            />
            <FieldHint>A project with no update for this long needs a look.</FieldHint>
          </div>
          <div className="space-y-1">
            <Label htmlFor="contact_followup_days">Contact follow-up (days)</Label>
            <Input
              id="contact_followup_days"
              type="number"
              min={1}
              max={365}
              value={v.contact_followup_days}
              onChange={(e) => set('contact_followup_days', clampDays(e.target.value))}
            />
            <FieldHint>Follow up with a contact after this many days.</FieldHint>
          </div>
        </div>
      </FormSection>

      <FormSection title="Calendar & time zone">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="review_day">Review day</Label>
            <select
              id="review_day"
              className={selectClass}
              value={v.review_day}
              onChange={(e) => set('review_day', e.target.value)}
            >
              {REVIEW_DAYS.map((d) => (
                <option key={d.key} value={d.key}>{d.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="week_start">Week starts</Label>
            <select
              id="week_start"
              className={selectClass}
              value={v.week_start}
              onChange={(e) => set('week_start', e.target.value)}
            >
              {WEEK_STARTS.map((d) => (
                <option key={d.key} value={d.key}>{d.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="time_zone">Time zone</Label>
            <select
              id="time_zone"
              className={selectClass}
              value={v.time_zone}
              onChange={(e) => set('time_zone', e.target.value)}
            >
              {TIME_ZONES.map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
          </div>
        </div>
      </FormSection>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center justify-end gap-3">
        {saved && <span className="text-sm text-muted-foreground">Saved</span>}
        <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </form>
  )
}

// ── Parent projects ──────────────────────────────────────────────────────────

/**
 * Parent projects card (FR-5). Lists the projects that have sub-projects, with
 * each one's sub-project count and a link to it, and an "Add parent project"
 * button that creates a plain top-level project (no parent of its own) via the
 * existing POST /api/tracker/plans. Renaming, re-parenting or moving
 * sub-projects stay on the project's Edit page, so this card only adds and
 * links — it never edits in place.
 */
function ParentProjectsCard({
  initial,
  categories,
  regions,
}: {
  initial: ParentProjectRow[]
  categories: SettingsOption[]
  regions: SettingsOption[]
}) {
  const [addOpen, setAddOpen] = useState(false)
  // A just-added parent won't appear in the list below until a project is
  // placed under it, so confirm the add explicitly (otherwise nothing seems to
  // happen). Cleared when the dialog is re-opened.
  const [added, setAdded] = useState(false)

  const rows = useMemo(
    () => [...initial].sort((a, b) => a.name.localeCompare(b.name)),
    [initial],
  )

  return (
    <FormSection title="Parent projects">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FieldHint>
          Projects that have sub-projects. Add one here, then pick it as the
          Parent on the New / Edit project form.
        </FieldHint>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setAdded(false)
            setAddOpen(true)
          }}
        >
          <Plus className="mr-1 h-4 w-4" aria-hidden />
          Add parent project
        </Button>
      </div>

      {added && (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
          Added. It&apos;s now in the Parent project list on the project form, and
          will show here once a project is placed under it.
        </p>
      )}

      <ul className="divide-y rounded-md border">
        {rows.length === 0 && (
          <li className="p-3 text-sm text-muted-foreground">
            No parent projects yet. Add one, or set a project&apos;s Parent on its Edit page.
          </li>
        )}
        {rows.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
            <Link href={`/tracker/plans/${p.id}`} className="text-sm font-medium hover:underline">
              {p.name}
            </Link>
            <span className="text-xs text-muted-foreground">
              {p.subCount} {p.subCount === 1 ? 'sub-project' : 'sub-projects'}
            </span>
          </li>
        ))}
      </ul>

      <AddParentProjectDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        categories={categories}
        regions={regions}
        onAdded={() => setAdded(true)}
      />
    </FormSection>
  )
}

function AddParentProjectDialog({
  open,
  onOpenChange,
  categories,
  regions,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  categories: SettingsOption[]
  regions: SettingsOption[]
  // Called after a successful add so the card can confirm it to the user.
  onAdded: () => void
}) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [region, setRegion] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setName('')
    setCategory('')
    setRegion('')
    setError(null)
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError('A name is required')
      return
    }
    if (!category) {
      setError('A category is required')
      return
    }
    setSaving(true)
    setError(null)
    try {
      // One call to the existing create endpoint: owned by me (server default),
      // no parent of its own, region optional.
      const res = await fetch('/api/tracker/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, category, region: region || null }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || 'Could not add the parent project')
        setSaving(false)
        return
      }
      setSaving(false)
      reset()
      onOpenChange(false)
      // Confirm the add in the card — the new parent has no sub-projects yet,
      // so it won't appear in the list below until a project is placed under it.
      onAdded()
      // Refresh so the new project shows in the project form's Parent dropdown
      // (and here, once it has sub-projects).
      router.refresh()
    } catch {
      setError('Could not add the parent project')
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Add a parent project</DialogTitle>
            <DialogDescription>
              Creates a top-level project you can then pick as the Parent on the
              New / Edit project form. Rename or re-parent it later on its Edit page.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-1">
              <Label htmlFor="parent-name">Name *</Label>
              <Input
                id="parent-name"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="parent-category">Category *</Label>
              <select
                id="parent-category"
                className={selectClass}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                required
              >
                <option value="">—</option>
                {categories.map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="parent-region">Region</Label>
              <select
                id="parent-region"
                className={selectClass}
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              >
                <option value="">—</option>
                {regions.map((r) => (
                  <option key={r.key} value={r.key}>{r.label}</option>
                ))}
              </select>
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Adding…' : 'Add parent project'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Lists manager ────────────────────────────────────────────────────────────

function ListsManager({ initial }: { initial: SettingsLookupRow[] }) {
  const router = useRouter()
  const [rows, setRows] = useState<SettingsLookupRow[]>(initial)
  const [selectedList, setSelectedList] = useState<string>(LISTS[0].list)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  const current = useMemo(
    () =>
      rows
        .filter((r) => r.list === selectedList)
        .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label)),
    [rows, selectedList],
  )

  async function patchRow(id: string, patch: Partial<Pick<SettingsLookupRow, 'label' | 'active' | 'sort_order'>>) {
    const res = await fetch(`/api/tracker/lookups/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || 'Could not save the change')
    return body.data as SettingsLookupRow
  }

  async function onRename(id: string, label: string) {
    const existing = rows.find((r) => r.id === id)
    if (!existing || existing.label === label) return
    setBusyId(id)
    setError(null)
    try {
      const updated = await patchRow(id, { label })
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, label: updated.label } : r)))
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the change')
    } finally {
      setBusyId(null)
    }
  }

  async function onToggle(id: string, active: boolean) {
    setBusyId(id)
    setError(null)
    try {
      await patchRow(id, { active })
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, active } : r)))
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the change')
    } finally {
      setBusyId(null)
    }
  }

  async function onMove(id: string, dir: 'up' | 'down') {
    const index = current.findIndex((r) => r.id === id)
    const swapWith = dir === 'up' ? index - 1 : index + 1
    if (index < 0 || swapWith < 0 || swapWith >= current.length) return
    const a = current[index]
    const b = current[swapWith]
    setBusyId(id)
    setError(null)
    try {
      // Swap the two sort orders (two writes). The DB enforces editor rights.
      await Promise.all([
        patchRow(a.id, { sort_order: b.sort_order }),
        patchRow(b.id, { sort_order: a.sort_order }),
      ])
      setRows((prev) =>
        prev.map((r) => {
          if (r.id === a.id) return { ...r, sort_order: b.sort_order }
          if (r.id === b.id) return { ...r, sort_order: a.sort_order }
          return r
        }),
      )
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reorder')
    } finally {
      setBusyId(null)
    }
  }

  function onAdded(row: SettingsLookupRow) {
    setRows((prev) => [...prev, row])
    router.refresh()
  }

  const selectedLabel = LISTS.find((l) => l.list === selectedList)?.label ?? selectedList

  return (
    <FormSection title="Lists">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <Label htmlFor="list-picker">List</Label>
          <select
            id="list-picker"
            className={cn(selectClass, 'w-auto min-w-[14rem]')}
            value={selectedList}
            onChange={(e) => setSelectedList(e.target.value)}
          >
            {LISTS.map((l) => (
              <option key={l.list} value={l.list}>{l.label}</option>
            ))}
          </select>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="mr-1 h-4 w-4" aria-hidden />
          Add value
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <ul className="divide-y rounded-md border">
        {current.length === 0 && (
          <li className="p-3 text-sm text-muted-foreground">No values yet. Add one to get started.</li>
        )}
        {current.map((r, i) => (
          <ListRow
            key={r.id}
            row={r}
            isFirst={i === 0}
            isLast={i === current.length - 1}
            busy={busyId === r.id}
            onRename={onRename}
            onToggle={onToggle}
            onMove={onMove}
          />
        ))}
      </ul>

      <FieldHint>Keys never change once used; hide a value instead of deleting it.</FieldHint>

      <AddValueDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        list={selectedList}
        listLabel={selectedLabel}
        onAdded={onAdded}
      />
    </FormSection>
  )
}

function ListRow({
  row,
  isFirst,
  isLast,
  busy,
  onRename,
  onToggle,
  onMove,
}: {
  row: SettingsLookupRow
  isFirst: boolean
  isLast: boolean
  busy: boolean
  onRename: (id: string, label: string) => void
  onToggle: (id: string, active: boolean) => void
  onMove: (id: string, dir: 'up' | 'down') => void
}) {
  const [label, setLabel] = useState(row.label)

  return (
    <li className="flex flex-wrap items-center gap-3 p-3">
      <div className="flex shrink-0 flex-col">
        <button
          type="button"
          aria-label="Move up"
          disabled={isFirst || busy}
          onClick={() => onMove(row.id, 'up')}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronUp className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Move down"
          disabled={isLast || busy}
          onClick={() => onMove(row.id, 'down')}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronDown className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div className="min-w-[10rem] flex-1">
        <Input
          aria-label={`Label for ${row.key}`}
          value={label}
          disabled={busy}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => {
            const trimmed = label.trim()
            if (trimmed && trimmed !== row.label) onRename(row.id, trimmed)
            else setLabel(row.label)
          }}
        />
        <p className="mt-1 text-xs text-muted-foreground">Key: {row.key}</p>
      </div>

      <div className="shrink-0">
        <ToggleSwitch
          checked={row.active}
          disabled={busy}
          onCheckedChange={(checked) => onToggle(row.id, checked)}
          label={row.active ? 'Shown' : 'Hidden'}
        />
      </div>
    </li>
  )
}

function AddValueDialog({
  open,
  onOpenChange,
  list,
  listLabel,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  list: string
  listLabel: string
  onAdded: (row: SettingsLookupRow) => void
}) {
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = label.trim()
    if (!trimmed) {
      setError('A label is required')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/tracker/lookups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ list, label: trimmed }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || 'Could not add the value')
        setSaving(false)
        return
      }
      onAdded(body.data as SettingsLookupRow)
      setLabel('')
      setSaving(false)
      onOpenChange(false)
    } catch {
      setError('Could not add the value')
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setLabel('')
          setError(null)
        }
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Add a value to {listLabel}</DialogTitle>
            <DialogDescription>
              Type a label. The key is generated from it and never changes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1 py-4">
            <Label htmlFor="new-value-label">Label</Label>
            <Input
              id="new-value-label"
              value={label}
              autoFocus
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Adding…' : 'Add value'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
