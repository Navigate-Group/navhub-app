'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { cn } from '@/lib/utils'
import { relativeWhen } from '@/lib/tracker/view'

export type CommentItem = {
  id: string
  body: string
  authorName: string
  createdAt: string
  edited: boolean
  // Whether the signed-in user may edit this comment (they are the author).
  canEdit: boolean
  // Whether the signed-in user may delete this comment (author or editor).
  canDelete: boolean
}

/**
 * Comments box on the project page. Lists project comments oldest → newest
 * (newest at the bottom). Anyone with Comment or Edit access (and all Managers /
 * Group Owners) sees the add box; others just read. The author edits / deletes
 * their own; Managers / Group Owners can delete anyone's. The database is the
 * real guard (082).
 */
export default function CommentsSection({
  planId,
  comments,
  canPost,
}: {
  planId: string
  comments: CommentItem[]
  canPost: boolean
}) {
  const router = useRouter()
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<CommentItem | null>(null)

  async function onPost(e: React.FormEvent) {
    e.preventDefault()
    if (!draft.trim()) return
    setPosting(true)
    setError(null)
    try {
      const res = await fetch('/api/tracker/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_id: planId, body: draft }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        setError(b.error || 'Could not post the comment')
      } else {
        setDraft('')
        router.refresh()
      }
    } catch {
      setError('Could not post the comment')
    } finally {
      setPosting(false)
    }
  }

  async function onSaveEdit(id: string) {
    if (!editText.trim()) return
    setSavingId(id)
    setError(null)
    try {
      const res = await fetch(`/api/tracker/comments/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: editText }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        setError(b.error || 'Could not save the comment')
      } else {
        setEditingId(null)
        router.refresh()
      }
    } catch {
      setError('Could not save the comment')
    } finally {
      setSavingId(null)
    }
  }

  async function onDelete(c: CommentItem) {
    setError(null)
    try {
      const res = await fetch(`/api/tracker/comments/${c.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        setError(b.error || 'Could not delete the comment')
      } else {
        setDeleting(null)
        router.refresh()
      }
    } catch {
      setError('Could not delete the comment')
    }
  }

  const textareaClass = cn(
    'w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm',
    'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
  )

  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Comments</h2>

      {error && <p className="mb-2 text-sm text-destructive">{error}</p>}

      {comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet.</p>
      ) : (
        <ul className="space-y-3">
          {comments.map((c) => (
            <li key={c.id} className="space-y-1 text-sm">
              {editingId === c.id ? (
                <div className="space-y-2">
                  <textarea
                    rows={3}
                    className={textareaClass}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button size="sm" disabled={savingId === c.id} onClick={() => onSaveEdit(c.id)}>
                      {savingId === c.id ? 'Saving…' : 'Save'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="whitespace-pre-line">{c.body}</p>
                  <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{c.authorName}</span>
                    <span>· {relativeWhen(c.createdAt)}</span>
                    {c.edited && <span>· edited</span>}
                    {(c.canEdit || c.canDelete) && (
                      <span className="ml-auto flex gap-1">
                        {c.canEdit && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2"
                            onClick={() => {
                              setEditingId(c.id)
                              setEditText(c.body)
                            }}
                          >
                            Edit
                          </Button>
                        )}
                        {c.canDelete && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-destructive"
                            onClick={() => setDeleting(c)}
                          >
                            Delete
                          </Button>
                        )}
                      </span>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {canPost && (
        <form onSubmit={onPost} className="mt-4 space-y-2">
          <textarea
            rows={3}
            className={textareaClass}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a comment"
            aria-label="Add a comment"
          />
          <Button type="submit" size="sm" disabled={posting || !draft.trim()}>
            {posting ? 'Posting…' : 'Post comment'}
          </Button>
        </form>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this comment?"
        description="The comment is hidden from the project. It's kept in the database as removed."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => deleting && onDelete(deleting)}
      />
    </section>
  )
}
