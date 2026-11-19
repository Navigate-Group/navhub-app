'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

/**
 * Header action buttons for a project (P5):
 *   Edit               — when the user can edit the plan
 *   Archive / Restore  — Managers / Group Owners
 *   Delete permanently — only the plan's owner, with a confirm dialog
 * Button visibility is a convenience; the database is the real guard.
 */
export default function PlanActions({
  planId,
  archived,
  canEdit,
  isEditor,
  isOwner,
}: {
  planId: string
  archived: boolean
  canEdit: boolean
  isEditor: boolean
  isOwner: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function setArchived(next: boolean) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/tracker/plans/${planId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archive: next }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error || 'Could not update the project')
      } else {
        router.refresh()
      }
    } catch {
      setError('Could not update the project')
    } finally {
      setBusy(false)
    }
  }

  async function onDelete() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/tracker/plans/${planId}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error || 'Could not delete the project')
        setBusy(false)
      } else {
        router.push('/tracker/plans')
        router.refresh()
      }
    } catch {
      setError('Could not delete the project')
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {canEdit && (
          <Button asChild size="sm" variant="outline">
            <Link href={`/tracker/plans/${planId}/edit`}>Edit</Link>
          </Button>
        )}
        {isEditor && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setArchived(!archived)}>
            {archived ? 'Restore' : 'Archive'}
          </Button>
        )}
        {isOwner && (
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => setConfirmDelete(true)}>
            Delete permanently
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this project?"
        description="This permanently deletes the project and everything in it. This cannot be undone."
        confirmLabel="Delete permanently"
        variant="destructive"
        onConfirm={onDelete}
      />
    </div>
  )
}
