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

export type ContactValues = {
  name: string
  org: string
  role: string
  phone: string
  email: string
  notes: string
}

export type ExistingContact = {
  id: string
  name: string
  org: string | null
  role: string | null
}

const textareaClass = cn(
  'w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm',
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
)

/**
 * Add / edit a contact on a project (dialog). In "add" mode you can either pick
 * an existing group contact (search by name) and link it, or fill in the fields
 * to create a new one — either way it's linked to this project. In "edit" mode
 * the fields update the contact. The database is the guard (082).
 */
export default function ContactForm({
  open,
  onOpenChange,
  mode,
  planId,
  contactId,
  initial,
  linkable,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'add' | 'edit'
  planId: string
  contactId?: string
  initial: ContactValues
  // Existing group contacts not yet linked to this project (add mode only).
  linkable?: ExistingContact[]
}) {
  const router = useRouter()
  const [v, setV] = useState<ContactValues>(initial)
  const [search, setSearch] = useState('')
  const [pickedId, setPickedId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof ContactValues>(key: K, value: ContactValues[K]) {
    setV((prev) => ({ ...prev, [key]: value }))
  }

  const matches = (linkable ?? []).filter((c) =>
    c.name.toLowerCase().includes(search.trim().toLowerCase()),
  )

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (mode === 'add' && pickedId) {
      // Link an existing contact.
      setSaving(true)
      try {
        const res = await fetch('/api/tracker/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan_id: planId, contact_id: pickedId }),
        })
        const b = await res.json().catch(() => ({}))
        if (!res.ok) {
          setError(b.error || 'Could not add the contact')
          setSaving(false)
          return
        }
        onOpenChange(false)
        router.refresh()
      } catch {
        setError('Could not add the contact')
        setSaving(false)
      }
      return
    }

    if (!v.name.trim()) return setError('A contact name is required')
    setSaving(true)

    const payload: Record<string, unknown> = {
      name: v.name,
      org: v.org || null,
      role: v.role || null,
      phone: v.phone || null,
      email: v.email || null,
      notes: v.notes || null,
    }

    try {
      const res =
        mode === 'add'
          ? await fetch('/api/tracker/contacts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ plan_id: planId, ...payload }),
            })
          : await fetch(`/api/tracker/contacts/${contactId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            })
      const b = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(b.error || 'Could not save the contact')
        setSaving(false)
        return
      }
      onOpenChange(false)
      router.refresh()
    } catch {
      setError('Could not save the contact')
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === 'add' ? 'Add contact' : 'Edit contact'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          {mode === 'add' && (linkable?.length ?? 0) > 0 && (
            <div className="space-y-2 rounded-lg border bg-background p-3">
              <Label htmlFor="c-search">Link an existing contact</Label>
              <Input
                id="c-search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setPickedId(null)
                }}
                placeholder="Search by name"
              />
              {search.trim() && (
                <ul className="max-h-40 space-y-1 overflow-y-auto">
                  {matches.length === 0 ? (
                    <li className="text-xs text-muted-foreground">No match. Create a new contact below.</li>
                  ) : (
                    matches.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => setPickedId(c.id)}
                          className={cn(
                            'w-full rounded-md px-2 py-1 text-left text-sm hover:bg-muted',
                            pickedId === c.id && 'bg-muted font-medium',
                          )}
                        >
                          {c.name}
                          {(c.org || c.role) && (
                            <span className="text-muted-foreground">
                              {' '}· {[c.org, c.role].filter(Boolean).join(' · ')}
                            </span>
                          )}
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              )}
              {pickedId && (
                <p className="text-xs text-muted-foreground">
                  Linking an existing contact. Clear the search to create a new one instead.
                </p>
              )}
            </div>
          )}

          {!pickedId && (
            <>
              <div className="space-y-1">
                <Label htmlFor="c-name">Name *</Label>
                <Input id="c-name" value={v.name} onChange={(e) => set('name', e.target.value)} required={!pickedId} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="c-org">Organisation</Label>
                  <Input id="c-org" value={v.org} onChange={(e) => set('org', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="c-role">Role</Label>
                  <Input id="c-role" value={v.role} onChange={(e) => set('role', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="c-phone">Phone</Label>
                  <Input id="c-phone" value={v.phone} onChange={(e) => set('phone', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="c-email">Email</Label>
                  <Input id="c-email" type="email" value={v.email} onChange={(e) => set('email', e.target.value)} />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="c-notes">Notes</Label>
                <textarea
                  id="c-notes"
                  rows={3}
                  className={textareaClass}
                  value={v.notes}
                  onChange={(e) => set('notes', e.target.value)}
                />
              </div>
            </>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : mode === 'add' ? (pickedId ? 'Link contact' : 'Add contact') : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
