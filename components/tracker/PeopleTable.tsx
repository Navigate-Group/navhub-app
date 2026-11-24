'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import ContactForm from '@/components/tracker/ContactForm'
import { cn } from '@/lib/utils'
import { daysBetweenISO } from '@/lib/tracker/view'

/**
 * People (FR — external contacts) — client table.
 * ──────────────────────────────────────────────────────────────────────────
 * The group's external points of contact (partners, suppliers, growers, …),
 * with their linked projects and when they were last spoken to. Contacts not
 * spoken to for the follow-up window (or never) are highlighted so the team can
 * keep relationships warm.
 *
 * Inline actions per row (shown only where the database permits — the DB is the
 * guard, 082): "Contacted today" sets last_contact to today; "+ Call" creates a
 * Call action due today assigned to the signed-in user, linked to the contact
 * and one of its projects; "Edit" opens the shared ContactForm. A database
 * refusal surfaces as a clear message.
 *
 * Wide screens get a table; narrow screens get cards. The search box filters by
 * name, organisation or project name.
 */

export type PeopleProject = { id: string; name: string }

export type PersonRow = {
  id: string
  name: string
  org: string | null
  role: string | null
  phone: string | null
  email: string | null
  notes: string | null
  last_contact: string | null
  projects: PeopleProject[]
  canEdit: boolean
}

/** "today", "yesterday", "N days ago", or "never" for a last-contact date. */
function lastContactLabel(lastContact: string | null, today: string): string {
  if (!lastContact) return 'never'
  const days = daysBetweenISO(lastContact, today)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

/** Overdue = never contacted, or last contact is at/over the follow-up window. */
function isOverdue(lastContact: string | null, today: string, followUpDays: number): boolean {
  if (!lastContact) return true
  return daysBetweenISO(lastContact, today) >= followUpDays
}

export default function PeopleTable({
  people,
  canAdd,
  followUpDays,
  today,
  currentUserId,
}: {
  people: PersonRow[]
  canAdd: boolean
  followUpDays: number
  today: string
  currentUserId: string
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Optimistic last_contact overrides (contact id → ISO date) applied straight
  // away on "Contacted today", before the quiet refresh reconciles.
  const [contactedOn, setContactedOn] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<PersonRow | null>(null)
  const [pickProjectFor, setPickProjectFor] = useState<PersonRow | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return people
    return people.filter((p) => {
      if (p.name.toLowerCase().includes(q)) return true
      if ((p.org ?? '').toLowerCase().includes(q)) return true
      if (p.projects.some((pr) => pr.name.toLowerCase().includes(q))) return true
      return false
    })
  }, [people, query])

  async function markContactedToday(p: PersonRow) {
    setBusyId(p.id)
    setError(null)
    setContactedOn((prev) => ({ ...prev, [p.id]: today }))
    try {
      const res = await fetch(`/api/tracker/contacts/${p.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ last_contact: today }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        setContactedOn((prev) => {
          const next = { ...prev }
          delete next[p.id]
          return next
        })
        setError(b.error || 'Could not update the contact')
      } else {
        startTransition(() => {
          router.refresh()
        })
      }
    } catch {
      setContactedOn((prev) => {
        const next = { ...prev }
        delete next[p.id]
        return next
      })
      setError('Could not update the contact')
    } finally {
      setBusyId(null)
    }
  }

  async function createCall(p: PersonRow, projectId: string) {
    setBusyId(p.id)
    setError(null)
    try {
      const res = await fetch('/api/tracker/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan_id: projectId,
          title: `Call ${p.name}`,
          type: 'call',
          status: 'open',
          due_on: today,
          assignee_id: currentUserId,
          contact_id: p.id,
        }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        setError(b.error || 'Could not create the call')
      } else {
        setPickProjectFor(null)
        startTransition(() => {
          router.refresh()
        })
      }
    } catch {
      setError('Could not create the call')
    } finally {
      setBusyId(null)
    }
  }

  function onAddCall(p: PersonRow) {
    setError(null)
    if (p.projects.length === 0) {
      setError(
        `Link ${p.name} to a project first — a call is added on one of the contact's projects.`,
      )
      return
    }
    if (p.projects.length === 1) {
      void createCall(p, p.projects[0].id)
      return
    }
    setPickProjectFor(p)
  }

  function effectiveLastContact(p: PersonRow): string | null {
    return contactedOn[p.id] ?? p.last_contact
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, organisation or project"
          className="max-w-sm"
          aria-label="Search contacts"
        />
        {canAdd && (
          <Button size="sm" onClick={() => setAdding(true)}>
            Add contact
          </Button>
        )}
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
          <p className="text-sm text-muted-foreground">
            {people.length === 0 ? 'No contacts yet.' : 'No contacts match your search.'}
          </p>
        </div>
      ) : (
        <>
          {/* Wide screens: table */}
          <div className="hidden overflow-x-auto rounded-xl border bg-card text-card-foreground shadow-sm md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Organisation · role</th>
                  <th className="px-3 py-2 font-medium">Phone · email</th>
                  <th className="px-3 py-2 font-medium">Projects</th>
                  <th className="px-3 py-2 font-medium">Last contact</th>
                  <th className="px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const last = effectiveLastContact(p)
                  const overdue = isOverdue(last, today, followUpDays)
                  return (
                    <tr key={p.id} className="border-b last:border-0 align-top">
                      <td className="px-3 py-2">
                        <div className="font-medium">{p.name}</div>
                        {p.notes && (
                          <div className="mt-0.5 whitespace-pre-line text-xs text-muted-foreground">
                            {p.notes}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {[p.org, p.role].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="px-3 py-2">
                        <div className="space-y-0.5">
                          {p.phone ? (
                            <a href={`tel:${p.phone}`} className="block text-primary hover:underline">
                              {p.phone}
                            </a>
                          ) : null}
                          {p.email ? (
                            <a href={`mailto:${p.email}`} className="block text-primary hover:underline">
                              {p.email}
                            </a>
                          ) : null}
                          {!p.phone && !p.email && <span className="text-muted-foreground">—</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {p.projects.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                            {p.projects.map((pr, i) => (
                              <span key={pr.id}>
                                <Link
                                  href={`/tracker/plans/${pr.id}`}
                                  className="text-primary hover:underline"
                                >
                                  {pr.name}
                                </Link>
                                {i < p.projects.length - 1 && <span aria-hidden>,</span>}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <LastContactBadge
                          label={lastContactLabel(last, today)}
                          overdue={overdue}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <RowActions
                          person={p}
                          busy={busyId === p.id}
                          onContacted={() => markContactedToday(p)}
                          onCall={() => onAddCall(p)}
                          onEdit={() => setEditing(p)}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Narrow screens: cards */}
          <ul className="space-y-3 md:hidden">
            {filtered.map((p) => {
              const last = effectiveLastContact(p)
              const overdue = isOverdue(last, today, followUpDays)
              return (
                <li
                  key={p.id}
                  className="space-y-2 rounded-xl border bg-card p-3 text-card-foreground shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium">{p.name}</div>
                      {(p.org || p.role) && (
                        <div className="text-xs text-muted-foreground">
                          {[p.org, p.role].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </div>
                    <LastContactBadge label={lastContactLabel(last, today)} overdue={overdue} />
                  </div>
                  {p.notes && (
                    <p className="whitespace-pre-line text-xs text-muted-foreground">{p.notes}</p>
                  )}
                  <div className="space-y-0.5 text-sm">
                    {p.phone && (
                      <a href={`tel:${p.phone}`} className="block text-primary hover:underline">
                        {p.phone}
                      </a>
                    )}
                    {p.email && (
                      <a href={`mailto:${p.email}`} className="block text-primary hover:underline">
                        {p.email}
                      </a>
                    )}
                  </div>
                  {p.projects.length > 0 && (
                    <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-sm">
                      {p.projects.map((pr, i) => (
                        <span key={pr.id}>
                          <Link
                            href={`/tracker/plans/${pr.id}`}
                            className="text-primary hover:underline"
                          >
                            {pr.name}
                          </Link>
                          {i < p.projects.length - 1 && <span aria-hidden>,</span>}
                        </span>
                      ))}
                    </div>
                  )}
                  <RowActions
                    person={p}
                    busy={busyId === p.id}
                    onContacted={() => markContactedToday(p)}
                    onCall={() => onAddCall(p)}
                    onEdit={() => setEditing(p)}
                  />
                </li>
              )
            })}
          </ul>
        </>
      )}

      <p className="text-xs text-muted-foreground">
        Sorted by organisation, then name. Contacts not spoken to for {followUpDays} days are
        highlighted. &lsquo;+ Call&rsquo; adds a call action due today.
      </p>

      {canAdd && adding && (
        <ContactForm
          open={adding}
          onOpenChange={setAdding}
          mode="add"
          planId=""
          initial={{ name: '', org: '', role: '', phone: '', email: '', notes: '' }}
        />
      )}

      {editing && (
        <ContactForm
          open={editing !== null}
          onOpenChange={(o) => !o && setEditing(null)}
          mode="edit"
          planId=""
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

      {/* Project picker when a contact is linked to more than one project */}
      <Dialog
        open={pickProjectFor !== null}
        onOpenChange={(o) => !o && setPickProjectFor(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Which project is this call for?</DialogTitle>
          </DialogHeader>
          <ul className="space-y-1">
            {pickProjectFor?.projects.map((pr) => (
              <li key={pr.id}>
                <button
                  type="button"
                  onClick={() => pickProjectFor && createCall(pickProjectFor, pr.id)}
                  disabled={busyId === pickProjectFor?.id}
                  className="w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                >
                  {pr.name}
                </button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function LastContactBadge({ label, overdue }: { label: string; overdue: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        overdue
          ? 'border-transparent bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
          : 'border-transparent bg-muted text-muted-foreground',
      )}
    >
      {label}
    </span>
  )
}

function RowActions({
  person,
  busy,
  onContacted,
  onCall,
  onEdit,
}: {
  person: PersonRow
  busy: boolean
  onContacted: () => void
  onCall: () => void
  onEdit: () => void
}) {
  if (!person.canEdit) {
    return <span className="text-xs text-muted-foreground">View only</span>
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      <Button size="sm" variant="outline" disabled={busy} onClick={onContacted}>
        Contacted today
      </Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={onCall}>
        + Call
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>
        Edit
      </Button>
    </div>
  )
}
