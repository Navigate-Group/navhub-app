'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import ContactForm, { type ExistingContact } from '@/components/tracker/ContactForm'
import { formatDate } from '@/lib/tracker/view'
import { cn } from '@/lib/utils'

export type ContactDetail = {
  id: string
  name: string
  org: string | null
  role: string | null
  phone: string | null
  email: string | null
  notes: string | null
  last_contact: string | null
  // Archived contacts are only shown when "Show archived" is on (Managers only).
  archived?: boolean
}

/**
 * Contacts box in the side column. Lists the project's contacts (name, then
 * "organisation · role"); clicking one opens its details. People with Edit
 * access see Add contact, Edit on each, and Remove from project. The database
 * is the guard (082).
 */
export default function ContactsSection({
  planId,
  contacts,
  canEdit,
  canArchive,
  linkable,
}: {
  planId: string
  contacts: ContactDetail[]
  canEdit: boolean
  // Managers / Group Owners may archive / restore a contact (DB-guarded too).
  canArchive: boolean
  // Group contacts not yet linked to this plan (for "link an existing one").
  linkable: ExistingContact[]
}) {
  const router = useRouter()
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<ContactDetail | null>(null)
  const [removing, setRemoving] = useState<ContactDetail | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onArchive(c: ContactDetail, archive: boolean) {
    setError(null)
    setBusyId(c.id)
    try {
      const res = await fetch(`/api/tracker/contacts/${c.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archive }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        setError(b.error || (archive ? 'Could not archive the contact' : 'Could not restore the contact'))
      } else {
        router.refresh()
      }
    } catch {
      setError(archive ? 'Could not archive the contact' : 'Could not restore the contact')
    } finally {
      setBusyId(null)
    }
  }

  async function onRemove(c: ContactDetail) {
    setError(null)
    try {
      const res = await fetch('/api/tracker/contacts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_id: planId, contact_id: c.id }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        setError(b.error || 'Could not remove the contact')
      } else {
        setRemoving(null)
        router.refresh()
      }
    } catch {
      setError('Could not remove the contact')
    }
  }

  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Contacts</h2>
        {canEdit && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>Add contact</Button>
        )}
      </div>

      {error && <p className="mb-2 text-sm text-destructive">{error}</p>}

      {contacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No contacts yet.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {contacts.map((c) => {
            const expanded = openId === c.id
            return (
              <li key={c.id} className="border-b pb-2 last:border-0 last:pb-0">
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => setOpenId(expanded ? null : c.id)}
                  aria-expanded={expanded}
                >
                  <span className={cn('font-medium', c.archived && 'text-muted-foreground line-through')}>{c.name}</span>
                  {c.archived && <span className="text-muted-foreground"> · Archived</span>}
                  {(c.org || c.role) && (
                    <span className="text-muted-foreground">
                      {' '}· {[c.org, c.role].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </button>

                {expanded && (
                  <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                    {c.phone && <div>Phone: <span className="text-foreground">{c.phone}</span></div>}
                    {c.email && (
                      <div>
                        Email:{' '}
                        <a href={`mailto:${c.email}`} className="text-primary underline">{c.email}</a>
                      </div>
                    )}
                    {c.notes && <div className="whitespace-pre-line">Notes: <span className="text-foreground">{c.notes}</span></div>}
                    <div>Last spoke: <span className="text-foreground">{c.last_contact ? formatDate(c.last_contact) : '—'}</span></div>
                    {(canEdit || canArchive) && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {c.archived ? (
                          canArchive && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2"
                              disabled={busyId === c.id}
                              onClick={() => onArchive(c, false)}
                            >
                              Restore
                            </Button>
                          )
                        ) : (
                          <>
                            {canEdit && (
                              <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditing(c)}>Edit</Button>
                            )}
                            {canArchive && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2"
                                disabled={busyId === c.id}
                                onClick={() => onArchive(c, true)}
                              >
                                Archive
                              </Button>
                            )}
                            {canEdit && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-destructive"
                                onClick={() => setRemoving(c)}
                              >
                                Remove from project
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {canEdit && adding && (
        <ContactForm
          open={adding}
          onOpenChange={setAdding}
          mode="add"
          planId={planId}
          initial={{ name: '', org: '', role: '', phone: '', email: '', notes: '' }}
          linkable={linkable}
        />
      )}

      {canEdit && editing && (
        <ContactForm
          open={editing !== null}
          onOpenChange={(o) => !o && setEditing(null)}
          mode="edit"
          planId={planId}
          contactId={editing.id}
          initial={{
            name: editing.name,
            org: editing.org ?? '',
            role: editing.role ?? '',
            phone: editing.phone ?? '',
            email: editing.email ?? '',
            notes: editing.notes ?? '',
          }}
        />
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove from project?"
        description="This unlinks the contact from this project. The contact itself is kept."
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={() => removing && onRemove(removing)}
      />
    </section>
  )
}
