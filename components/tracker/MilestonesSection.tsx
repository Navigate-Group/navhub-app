'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import MilestoneForm, {
  type MilestoneValues,
  type Option,
  type Person,
} from '@/components/tracker/MilestoneForm'
import { formatDate } from '@/lib/tracker/view'

export type MilestoneItem = {
  id: string
  title: string
  description: string | null
  owner_id: string | null
  status: string
  health: string | null
  start_on: string | null
  due_on: string | null
  baseline_due_on: string | null
  priority: string | null
  progress_mode: 'manual' | 'from_actions'
  progress_pct: number
  // From the progress view (may be absent for a brand-new milestone):
  doneActions: number
  totalActions: number
  viewPct: number
  daysSlipped: number
  overdue: boolean
  statusLabel: string
  // Whether the current user may move this milestone's baseline (owner or editor).
  canEditBaseline: boolean
}

/**
 * Milestones box (P6). Lists the plan's milestones. People who can edit the
 * project see Add / Edit; Managers / Group Owners also see Delete (confirmed).
 * Everyone else sees the read-only list. The database is the real guard.
 */
export default function MilestonesSection({
  planId,
  milestones,
  canEdit,
  canDelete,
  statuses,
  priorities,
  people,
}: {
  planId: string
  milestones: MilestoneItem[]
  canEdit: boolean
  canDelete: boolean
  statuses: Option[]
  priorities: Option[]
  people: Person[]
}) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<MilestoneItem | null>(null)
  const [deleting, setDeleting] = useState<MilestoneItem | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onDelete(m: MilestoneItem) {
    setError(null)
    try {
      const res = await fetch(`/api/tracker/milestones/${m.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error || 'Could not delete the milestone')
      } else {
        setDeleting(null)
        router.refresh()
      }
    } catch {
      setError('Could not delete the milestone')
    }
  }

  const emptyInitial: MilestoneValues = {
    title: '',
    description: '',
    owner_id: '',
    status: statuses[0]?.key ?? 'backlog',
    health: 'on_track',
    start_on: '',
    due_on: '',
    baseline_due_on: '',
    priority: 'normal',
    progress_mode: 'from_actions',
    progress_pct: 0,
  }

  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Milestones</h2>
        {canEdit && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>Add milestone</Button>
        )}
      </div>

      {error && <p className="mb-2 text-sm text-destructive">{error}</p>}

      {milestones.length === 0 ? (
        <p className="text-sm text-muted-foreground">No milestones yet.</p>
      ) : (
        <ul className="space-y-3">
          {milestones.map((m) => {
            const pct = m.progress_mode === 'manual' ? m.progress_pct : m.viewPct
            return (
              <li key={m.id} className="space-y-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="font-medium">{m.title}</span>
                  <Badge variant="secondary">{m.statusLabel || m.status}</Badge>
                  {m.due_on && <span className="text-muted-foreground">due {formatDate(m.due_on)}</span>}
                  <span className="text-muted-foreground">{m.doneActions} of {m.totalActions} · {pct}%</span>
                  {m.daysSlipped > 0 && <Badge variant="warning">{m.daysSlipped} days slipped</Badge>}
                  {m.overdue && <Badge variant="error">Overdue</Badge>}
                  {(canEdit || canDelete) && (
                    <span className="ml-auto flex gap-1">
                      {canEdit && (
                        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditing(m)}>Edit</Button>
                      )}
                      {canDelete && (
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-destructive" onClick={() => setDeleting(m)}>Delete</Button>
                      )}
                    </span>
                  )}
                </div>
                <Progress value={pct} />
              </li>
            )
          })}
        </ul>
      )}

      {canEdit && adding && (
        <MilestoneForm
          open={adding}
          onOpenChange={setAdding}
          mode="new"
          planId={planId}
          initial={emptyInitial}
          statuses={statuses}
          priorities={priorities}
          people={people}
          canEditBaseline={true}
        />
      )}

      {canEdit && editing && (
        <MilestoneForm
          open={editing !== null}
          onOpenChange={(o) => !o && setEditing(null)}
          mode="edit"
          planId={planId}
          milestoneId={editing.id}
          initial={{
            title: editing.title,
            description: editing.description ?? '',
            owner_id: editing.owner_id ?? '',
            status: editing.status,
            health: editing.health ?? 'on_track',
            start_on: editing.start_on ?? '',
            due_on: editing.due_on ?? '',
            baseline_due_on: editing.baseline_due_on ?? '',
            priority: editing.priority ?? 'normal',
            progress_mode: editing.progress_mode,
            progress_pct: editing.progress_pct,
          }}
          statuses={statuses}
          priorities={priorities}
          people={people}
          canEditBaseline={editing.canEditBaseline}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this milestone?"
        description="This permanently deletes the milestone. This cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => deleting && onDelete(deleting)}
      />
    </section>
  )
}
