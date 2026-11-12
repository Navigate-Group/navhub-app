'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useToast } from './Toaster'

interface Method {
  id: string
  label: string
  price_series?: string
  price_measure?: string
  description?: string
  caveat?: string
}

/**
 * Valuation methods are stored inside markets_commodities.valuation_methods
 * (JSONB), so they are curated per-commodity and PUT back as a whole array.
 * Context-filtered: the method list shown is always the SELECTED commodity's.
 */
export default function ValuationMethodsManager({ commodity }: { commodity: string }) {
  const toast = useToast()
  const [methods, setMethods] = useState<Method[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Method | null>(null)
  const [draft, setDraft] = useState<Method>({ id: '', label: '' })
  const [confirmRemove, setConfirmRemove] = useState<Method | null>(null)

  const load = useCallback(async () => {
    if (!commodity) return
    setLoading(true)
    try {
      const res = await fetch(`/api/markets/manage/valuation-methods?commodity=${encodeURIComponent(commodity)}`, { cache: 'no-store' })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Load failed (${res.status})`)
      const json = await res.json()
      setMethods((json.methods ?? []) as Method[])
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [commodity, toast])

  useEffect(() => { void load() }, [load])

  const persist = async (next: Method[], successMsg: string) => {
    setSaving(true)
    try {
      const res = await fetch('/api/markets/manage/valuation-methods', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commodity, methods: next }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Save failed (${res.status})`)
      const json = await res.json()
      setMethods((json.methods ?? []) as Method[])
      toast.success(successMsg)
      setDialogOpen(false)
      setConfirmRemove(null)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const openCreate = () => { setEditing(null); setDraft({ id: '', label: '' }); setDialogOpen(true) }
  const openEdit = (m: Method) => { setEditing(m); setDraft({ ...m }); setDialogOpen(true) }

  const save = () => {
    if (!draft.id.trim() || !draft.label.trim()) { toast.error('ID and Label are required'); return }
    const clean: Method = {
      id: draft.id.trim(),
      label: draft.label.trim(),
      price_series: draft.price_series?.trim() || undefined,
      price_measure: draft.price_measure?.trim() || undefined,
      description: draft.description?.trim() || undefined,
      caveat: draft.caveat?.trim() || undefined,
    }
    let next: Method[]
    if (editing) {
      next = methods.map(m => (m.id === editing.id ? clean : m))
    } else {
      if (methods.some(m => m.id === clean.id)) { toast.error('A method with that ID already exists'); return }
      next = [...methods, clean]
    }
    void persist(next, editing ? 'Valuation method updated' : 'Valuation method added')
  }

  const remove = (m: Method) => void persist(methods.filter(x => x.id !== m.id), 'Valuation method removed')

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Valuation methods</h2>
          <p className="text-sm text-muted-foreground">
            Methods for the selected commodity. These drive the context-filtered valuation dropdowns.
          </p>
        </div>
        <Button size="sm" onClick={openCreate} disabled={!commodity}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add method
        </Button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">ID</th>
              <th className="px-3 py-2 font-medium">Label</th>
              <th className="px-3 py-2 font-medium">Price series</th>
              <th className="px-3 py-2 font-medium">Measure</th>
              <th className="px-3 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground"><Loader2 className="mx-auto h-4 w-4 animate-spin" /></td></tr>
            ) : methods.length === 0 ? (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No valuation methods for this commodity.</td></tr>
            ) : (
              methods.map(m => (
                <tr key={m.id} className="border-b border-border/50 last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">{m.id}</td>
                  <td className="px-3 py-2">{m.label}</td>
                  <td className="px-3 py-2 text-muted-foreground">{m.price_series ?? '—'}</td>
                  <td className="px-3 py-2 text-muted-foreground">{m.price_measure ?? '—'}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(m)} aria-label="Edit method">
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setConfirmRemove(m)} aria-label="Remove method">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit valuation method' : 'Add valuation method'}</DialogTitle>
            <DialogDescription>Saved into the commodity&apos;s valuation methods. The change is recorded in the audit log.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Field label="ID" required>
              <Input value={draft.id} disabled={!!editing} placeholder="global_import"
                onChange={e => setDraft(d => ({ ...d, id: e.target.value }))} />
            </Field>
            <Field label="Label" required>
              <Input value={draft.label} placeholder="Global import price"
                onChange={e => setDraft(d => ({ ...d, label: e.target.value }))} />
            </Field>
            <Field label="Price series">
              <Input value={draft.price_series ?? ''} placeholder="wb_banana_us"
                onChange={e => setDraft(d => ({ ...d, price_series: e.target.value }))} />
            </Field>
            <Field label="Price measure">
              <Input value={draft.price_measure ?? ''} placeholder="production"
                onChange={e => setDraft(d => ({ ...d, price_measure: e.target.value }))} />
            </Field>
            <Field label="Description">
              <Input value={draft.description ?? ''}
                onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} />
            </Field>
            <Field label="Caveat">
              <Input value={draft.caveat ?? ''}
                onChange={e => setDraft(d => ({ ...d, caveat: e.target.value }))} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {editing ? 'Save changes' : 'Add method'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!confirmRemove}
        onOpenChange={o => { if (!o) setConfirmRemove(null) }}
        title="Remove valuation method?"
        description="This removes the method from the commodity. The change is recorded in the audit log."
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={() => { if (confirmRemove) remove(confirmRemove) }}
      />
    </section>
  )
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}{required && <span className="text-destructive"> *</span>}</Label>
      {children}
    </div>
  )
}
