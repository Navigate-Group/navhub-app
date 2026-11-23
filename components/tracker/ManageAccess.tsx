'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { cn } from '@/lib/utils'

export type AccessPerson = {
  id: string
  name: string
  role: string
  level: 'comment' | 'edit'
}

export type PickablePerson = {
  id: string
  name: string
  role: string
}

const selectClass = cn(
  'h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm',
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
)

const ROLE_LABELS: Record<string, string> = {
  manager: 'Manager',
  group_owner: 'Group Owner',
  group_admin: 'Group Admin',
  super_admin: 'Super Admin',
  staff: 'Staff',
  viewer: 'Viewer',
}

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
}

/**
 * Give / change / remove project access (Managers and Group Owners only; the
 * database is the real guard, 082). The picker offers non-editor members who
 * don't already have access; people with access are listed with their role and
 * level.
 */
export default function ManageAccess({
  planId,
  pickable,
  withAccess,
}: {
  planId: string
  pickable: PickablePerson[]
  withAccess: AccessPerson[]
}) {
  const router = useRouter()
  const [pickedId, setPickedId] = useState('')
  const [level, setLevel] = useState<'comment' | 'edit'>('comment')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<AccessPerson | null>(null)

  const withAccessIds = new Set(withAccess.map((p) => p.id))
  const available = pickable.filter((p) => !withAccessIds.has(p.id))

  async function give(userId: string, lvl: 'comment' | 'edit') {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/tracker/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_id: planId, user_id: userId, level: lvl }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        setError(b.error || 'Could not give access')
      } else {
        setPickedId('')
        setLevel('comment')
        router.refresh()
      }
    } catch {
      setError('Could not give access')
    } finally {
      setBusy(false)
    }
  }

  async function remove(userId: string) {
    setError(null)
    try {
      const res = await fetch('/api/tracker/shares', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_id: planId, user_id: userId }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        setError(b.error || 'Could not remove access')
      } else {
        setRemoving(null)
        router.refresh()
      }
    } catch {
      setError('Could not remove access')
    }
  }

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Give access */}
      <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
        <h2 className="mb-3 text-sm font-semibold">Give access</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[12rem] flex-1 space-y-1">
            <label htmlFor="access-person" className="text-xs text-muted-foreground">Member</label>
            <select
              id="access-person"
              className={selectClass}
              value={pickedId}
              onChange={(e) => setPickedId(e.target.value)}
            >
              <option value="">Choose a member…</option>
              {available.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({roleLabel(p.role)})</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="access-level" className="text-xs text-muted-foreground">Level</label>
            <select
              id="access-level"
              className={selectClass}
              value={level}
              onChange={(e) => setLevel(e.target.value === 'edit' ? 'edit' : 'comment')}
            >
              <option value="comment">Comment</option>
              <option value="edit">Edit</option>
            </select>
          </div>
          <Button disabled={busy || !pickedId} onClick={() => pickedId && give(pickedId, level)}>
            Give access
          </Button>
        </div>
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          <li><span className="font-medium text-foreground">Comment:</span> read everything and leave comments.</li>
          <li><span className="font-medium text-foreground">Edit:</span> update milestones, actions, updates and contacts, and comment.</li>
        </ul>
        {available.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">
            Everyone eligible already has access. Managers and Group Owners aren&apos;t shown — they already have full access.
          </p>
        )}
      </section>

      {/* Who has access */}
      <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
        <h2 className="mb-3 text-sm font-semibold">Who has access</h2>
        {withAccess.length === 0 ? (
          <p className="text-sm text-muted-foreground">No one has been given access yet.</p>
        ) : (
          <ul className="space-y-2">
            {withAccess.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-medium">{p.name}</span>
                <span className="text-muted-foreground">{roleLabel(p.role)}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                  {p.level === 'edit' ? 'Edit' : 'Comment'}
                </span>
                <span className="ml-auto flex gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2"
                    disabled={busy}
                    onClick={() => give(p.id, p.level === 'edit' ? 'comment' : 'edit')}
                  >
                    {p.level === 'edit' ? 'Change to Comment' : 'Change to Edit'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-destructive"
                    onClick={() => setRemoving(p)}
                  >
                    Remove
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove access?"
        description="This takes away their access to this project straight away."
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={() => removing && remove(removing.id)}
      />
    </div>
  )
}
