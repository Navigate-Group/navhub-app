'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import ActionForm, { type ActionValues } from '@/components/tracker/ActionForm'
import type { Option, Person } from '@/components/tracker/MilestoneForm'
import { formatDate, daysBetweenISO } from '@/lib/tracker/view'
import { cn } from '@/lib/utils'

export type ActionItem = {
  id: string
  title: string
  type: string | null
  who: string | null
  assignee_id: string | null
  due_on: string | null
  status: string
  priority: string | null
  milestone_id: string | null
  contact_id: string | null
  notes: string | null
  waiting_since: string | null
  typeLabel: string
  assigneeName: string | null
  contactName: string | null
  // Whether the signed-in user may use the quick buttons on this action
  // (full edit access, or they are the assignee).
  canQuick: boolean
}

type Quick = 'done' | 'plus_day' | 'plus_week' | 'waiting' | 'back_to_me' | 'reopen'

/**
 * Actions box (P6). Lists the plan's actions (open first, then done). People who
 * can edit the project see Add / Edit; Managers / Group Owners also see Delete.
 * The assignee (even without project access) sees the quick buttons on their own
 * action. The database is the real guard.
 */
export default function ActionsSection({
  planId,
  actions,
  canEdit,
  canDelete,
  chaserDays,
  today,
  types,
  priorities,
  people,
  milestones,
  contacts,
}: {
  planId: string
  actions: ActionItem[]
  canEdit: boolean
  canDelete: boolean
  chaserDays: number
  today: string
  types: Option[]
  priorities: Option[]
  people: Person[]
  milestones: { id: string; title: string }[]
  contacts: { id: string; name: string }[]
}) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<ActionItem | null>(null)
  const [deleting, setDeleting] = useState<ActionItem | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function quick(a: ActionItem, q: Quick) {
    setBusyId(a.id)
    setError(null)
    try {
      const res = await fetch(`/api/tracker/actions/${a.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quick: q }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error || 'Could not update the action')
      } else {
        router.refresh()
      }
    } catch {
      setError('Could not update the action')
    } finally {
      setBusyId(null)
    }
  }

  async function onDelete(a: ActionItem) {
    setError(null)
    try {
      const res = await fetch(`/api/tracker/actions/${a.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error || 'Could not delete the action')
      } else {
        setDeleting(null)
        router.refresh()
      }
    } catch {
      setError('Could not delete the action')
    }
  }

  const emptyInitial: ActionValues = {
    title: '',
    type: '',
    who: '',
    assignee_id: '',
    due_on: '',
    status: 'open',
    priority: 'normal',
    milestone_id: '',
    contact_id: '',
    notes: '',
  }

  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Actions</h2>
        {canEdit && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>Add action</Button>
        )}
      </div>

      {error && <p className="mb-2 text-sm text-destructive">{error}</p>}

      {actions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No actions yet.</p>
      ) : (
        <ul className="space-y-2">
          {actions.map((a) => {
            const waitingDays =
              a.status === 'waiting' && a.waiting_since ? daysBetweenISO(a.waiting_since, today) : 0
            const waitingTooLong = waitingDays > chaserDays
            const busy = busyId === a.id
            return (
              <li key={a.id} className="space-y-1 border-b pb-2 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <Badge variant={a.status === 'done' ? 'success' : a.status === 'waiting' ? 'warning' : 'secondary'}>
                    {a.status === 'done' ? 'Done' : a.status === 'waiting' ? 'Waiting' : 'Open'}
                  </Badge>
                  <span className="font-medium">{a.title}</span>
                  {a.typeLabel && <span className="text-muted-foreground">{a.typeLabel}</span>}
                  <span className="text-muted-foreground">
                    {a.assigneeName || a.who || '—'}
                  </span>
                  {a.contactName && <span className="text-muted-foreground">· {a.contactName}</span>}
                  {a.due_on && <span className="text-muted-foreground">due {formatDate(a.due_on)}</span>}
                  {a.status === 'waiting' && (
                    <span className={cn('text-xs', waitingTooLong ? 'font-medium text-red-600 dark:text-red-400' : 'text-muted-foreground')}>
                      Waiting {waitingDays} day{waitingDays === 1 ? '' : 's'}
                    </span>
                  )}
                  {(canEdit || canDelete) && (
                    <span className="ml-auto flex gap-1">
                      {canEdit && (
                        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditing(a)}>Edit</Button>
                      )}
                      {canDelete && (
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-destructive" onClick={() => setDeleting(a)}>Delete</Button>
                      )}
                    </span>
                  )}
                </div>

                {a.canQuick && (
                  <div className="flex flex-wrap gap-1.5">
                    {a.status === 'open' && (
                      <>
                        <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy} onClick={() => quick(a, 'done')}>Done</Button>
                        <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy} onClick={() => quick(a, 'plus_day')}>+1 day</Button>
                        <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy} onClick={() => quick(a, 'plus_week')}>+1 week</Button>
                        <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy} onClick={() => quick(a, 'waiting')}>Waiting</Button>
                      </>
                    )}
                    {a.status === 'waiting' && (
                      <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy} onClick={() => quick(a, 'back_to_me')}>Back to me</Button>
                    )}
                    {a.status === 'done' && (
                      <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy} onClick={() => quick(a, 'reopen')}>Reopen</Button>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {canEdit && adding && (
        <ActionForm
          open={adding}
          onOpenChange={setAdding}
          mode="new"
          planId={planId}
          initial={emptyInitial}
          types={types}
          priorities={priorities}
          people={people}
          milestones={milestones}
          contacts={contacts}
        />
      )}

      {canEdit && editing && (
        <ActionForm
          open={editing !== null}
          onOpenChange={(o) => !o && setEditing(null)}
          mode="edit"
          planId={planId}
          actionId={editing.id}
          initial={{
            title: editing.title,
            type: editing.type ?? '',
            who: editing.who ?? '',
            assignee_id: editing.assignee_id ?? '',
            due_on: editing.due_on ?? '',
            status: editing.status,
            priority: editing.priority ?? 'normal',
            milestone_id: editing.milestone_id ?? '',
            contact_id: editing.contact_id ?? '',
            notes: editing.notes ?? '',
          }}
          types={types}
          priorities={priorities}
          people={people}
          milestones={milestones}
          contacts={contacts}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this action?"
        description="This permanently deletes the action. This cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => deleting && onDelete(deleting)}
      />
    </section>
  )
}
