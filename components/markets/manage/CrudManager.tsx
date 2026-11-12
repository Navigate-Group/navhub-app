'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Pencil, Archive, ArchiveRestore, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { cn } from '@/lib/utils'
import { useToast } from './Toaster'

/** A row the table manages; must expose a stable primary key + archived flag. */
export interface CrudRow {
  id: string
  archived_at: string | null
  [k: string]: unknown
}

/** A dropdown option (for select fields + context-filtered dropdowns). */
export interface SelectOption {
  value: string
  label: string
}

/** A single field in the add / edit form. */
export interface FieldDef<R extends CrudRow> {
  name: string
  label: string
  type?: 'text' | 'number' | 'textarea' | 'select'
  required?: boolean
  placeholder?: string
  /** Options for select fields; a function receives the current draft so a
   *  dropdown can be context-filtered (e.g. seasons by commodity). */
  options?: SelectOption[] | ((draft: Record<string, string>) => SelectOption[])
  /** Only editable on create (e.g. an immutable primary key). */
  createOnly?: boolean
  /** How to render the value in the table cell. */
  cell?: (row: R) => React.ReactNode
  /** Hide this field from the table (form-only). */
  hideInTable?: boolean
}

export interface CrudManagerProps<R extends CrudRow> {
  title: string
  description?: string
  endpoint: string
  /** The table's columns / form fields. */
  fields: FieldDef<R>[]
  /** Label for the add button + dialog, singular (e.g. "source"). */
  itemNoun: string
  /** Extra query string appended to the GET (e.g. commodity filter). */
  query?: string
}

export default function CrudManager<R extends CrudRow>({
  title,
  description,
  endpoint,
  fields,
  itemNoun,
  query,
}: CrudManagerProps<R>) {
  const toast = useToast()
  const [rows, setRows] = useState<R[]>([])
  const [loading, setLoading] = useState(true)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<R | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState<{ row: R; archive: boolean } | null>(null)

  const buildUrl = useCallback(() => {
    const params = new URLSearchParams(query ?? '')
    if (includeArchived) params.set('includeArchived', '1')
    const qs = params.toString()
    return qs ? `${endpoint}?${qs}` : endpoint
  }, [endpoint, includeArchived, query])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(buildUrl(), { cache: 'no-store' })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Load failed (${res.status})`)
      const json = await res.json()
      setRows((json.rows ?? []) as R[])
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [buildUrl, toast])

  useEffect(() => { void load() }, [load])

  const openCreate = () => {
    setEditing(null)
    setDraft({})
    setDialogOpen(true)
  }

  const openEdit = (row: R) => {
    setEditing(row)
    const next: Record<string, string> = {}
    for (const f of fields) {
      const v = row[f.name]
      next[f.name] = v === null || v === undefined ? '' : Array.isArray(v) ? (v as unknown[]).join(', ') : String(v)
    }
    setDraft(next)
    setDialogOpen(true)
  }

  const save = async () => {
    // Required-field validation.
    for (const f of fields) {
      if (f.required && !(editing && f.createOnly) && !draft[f.name]?.trim()) {
        toast.error(`${f.label} is required`)
        return
      }
    }
    setSaving(true)
    try {
      const payload: Record<string, unknown> = {}
      for (const f of fields) {
        if (editing && f.createOnly) continue
        const raw = draft[f.name] ?? ''
        payload[f.name] = f.type === 'number'
          ? (raw.trim() === '' ? null : Number(raw))
          : raw
      }
      if (editing) payload.id = editing.id

      const res = await fetch(endpoint, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Save failed (${res.status})`)
      toast.success(editing ? `${cap(itemNoun)} updated` : `${cap(itemNoun)} added`)
      setDialogOpen(false)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const doArchive = async (row: R, archive: boolean) => {
    try {
      const res = await fetch(endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id, archived: archive }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Update failed (${res.status})`)
      toast.success(archive ? `${cap(itemNoun)} archived` : `${cap(itemNoun)} restored`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setConfirm(null)
    }
  }

  const visibleFields = useMemo(() => fields.filter(f => !f.hideInTable), [fields])

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={e => setIncludeArchived(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-input"
            />
            Show archived
          </label>
          <Button variant="outline" size="sm" onClick={() => void load()} aria-label="Refresh">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add {itemNoun}
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              {visibleFields.map(f => (
                <th key={f.name} className="px-3 py-2 font-medium">{f.label}</th>
              ))}
              <th className="px-3 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={visibleFields.length + 1} className="px-3 py-6 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={visibleFields.length + 1} className="px-3 py-6 text-center text-muted-foreground">
                  No {itemNoun}s yet.
                </td>
              </tr>
            ) : (
              rows.map(row => {
                const archived = !!row.archived_at
                return (
                  <tr key={row.id} className={cn('border-b border-border/50 last:border-0', archived && 'opacity-60')}>
                    {visibleFields.map(f => (
                      <td key={f.name} className="px-3 py-2 align-top">
                        {f.cell ? f.cell(row) : renderCell(row[f.name])}
                        {f.name === visibleFields[0].name && archived && (
                          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            Archived
                          </span>
                        )}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(row)} aria-label={`Edit ${itemNoun}`}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setConfirm({ row, archive: !archived })}
                          aria-label={archived ? `Restore ${itemNoun}` : `Archive ${itemNoun}`}
                        >
                          {archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Add / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${itemNoun}` : `Add ${itemNoun}`}</DialogTitle>
            <DialogDescription>
              {editing ? `Update this ${itemNoun}. The change is recorded in the audit log.` : `Create a new ${itemNoun}. The change is recorded in the audit log.`}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            {fields.map(f => {
              const disabled = !!(editing && f.createOnly)
              const options = typeof f.options === 'function' ? f.options(draft) : f.options
              return (
                <div key={f.name} className="grid gap-1.5">
                  <Label htmlFor={`fld-${f.name}`}>
                    {f.label}{f.required && <span className="text-destructive"> *</span>}
                  </Label>
                  {f.type === 'textarea' ? (
                    <textarea
                      id={`fld-${f.name}`}
                      className="min-h-[72px] rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                      value={draft[f.name] ?? ''}
                      placeholder={f.placeholder}
                      disabled={disabled}
                      onChange={e => setDraft(d => ({ ...d, [f.name]: e.target.value }))}
                    />
                  ) : f.type === 'select' ? (
                    <select
                      id={`fld-${f.name}`}
                      className="h-9 rounded-md border border-input bg-background px-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                      value={draft[f.name] ?? ''}
                      disabled={disabled}
                      onChange={e => setDraft(d => ({ ...d, [f.name]: e.target.value }))}
                    >
                      <option value="">— Select —</option>
                      {(options ?? []).map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id={`fld-${f.name}`}
                      type={f.type === 'number' ? 'number' : 'text'}
                      value={draft[f.name] ?? ''}
                      placeholder={f.placeholder}
                      disabled={disabled}
                      onChange={e => setDraft(d => ({ ...d, [f.name]: e.target.value }))}
                    />
                  )}
                </div>
              )
            })}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {editing ? 'Save changes' : `Add ${itemNoun}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Archive / restore confirmation */}
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={o => { if (!o) setConfirm(null) }}
        title={confirm?.archive ? `Archive ${itemNoun}?` : `Restore ${itemNoun}?`}
        description={
          confirm?.archive
            ? `This ${itemNoun} will be hidden from explorer dropdowns but kept in the database and audit log. You can restore it later.`
            : `This ${itemNoun} will become visible in explorer dropdowns again.`
        }
        confirmLabel={confirm?.archive ? 'Archive' : 'Restore'}
        variant={confirm?.archive ? 'destructive' : 'default'}
        onConfirm={() => { if (confirm) void doArchive(confirm.row, confirm.archive) }}
      />
    </section>
  )
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function renderCell(v: unknown): React.ReactNode {
  if (v === null || v === undefined || v === '') return <span className="text-muted-foreground">—</span>
  if (Array.isArray(v)) return v.length ? v.join(', ') : <span className="text-muted-foreground">—</span>
  if (typeof v === 'object') return <span className="text-muted-foreground">…</span>
  return String(v)
}
