'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'

/**
 * Status select that saves straight away (P5). Shown only when the user can
 * edit; the detail page renders plain text otherwise. A database refusal is
 * shown as a clear message and the select reverts.
 */
export default function PlanStatusSelect({
  planId,
  current,
  options,
}: {
  planId: string
  current: string
  options: { key: string; label: string }[]
}) {
  const router = useRouter()
  const [value, setValue] = useState(current)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onChange(next: string) {
    const previous = value
    setValue(next)
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/tracker/plans/${planId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next || null }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setValue(previous)
        setError(body.error || 'Could not change the status')
      } else {
        router.refresh()
      }
    } catch {
      setValue(previous)
      setError('Could not change the status')
    } finally {
      setSaving(false)
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <select
        aria-label="Project status"
        value={value}
        disabled={saving}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
        )}
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
      </select>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  )
}
