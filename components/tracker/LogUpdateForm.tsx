'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/**
 * Log-update form (P5) for users who can edit. After saving, the plan's
 * "Last updated" moves forward (migration 079's trigger).
 */
export default function LogUpdateForm({
  planId,
  sourceOptions,
  today,
}: {
  planId: string
  sourceOptions: { key: string; label: string }[]
  today: string
}) {
  const router = useRouter()
  const [date, setDate] = useState(today)
  const [source, setSource] = useState('')
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!text.trim()) {
      setError('An update needs some text')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/tracker/updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_id: planId, date, source: source || null, text }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error || 'Could not save the update')
      } else {
        setText('')
        setSource('')
        setDate(today)
        router.refresh()
      }
    } catch {
      setError('Could not save the update')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border bg-background p-3">
      <div className="flex flex-wrap gap-3">
        <div className="space-y-1">
          <Label htmlFor="update-date">Date</Label>
          <Input
            id="update-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-auto"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="update-source">Source</Label>
          <select
            id="update-source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className={cn(
              'h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            )}
          >
            <option value="">—</option>
            {sourceOptions.map((o) => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="update-text">Update</Label>
        <textarea
          id="update-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          className={cn(
            'flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm',
            'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
          placeholder="What changed?"
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? 'Saving…' : 'Log update'}
      </Button>
    </form>
  )
}
