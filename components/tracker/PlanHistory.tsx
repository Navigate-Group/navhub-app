'use client'

import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { HistoryItem } from '@/lib/tracker/history'

const PAGE_SIZE = 20

/**
 * Project History (P5.1): a collapsible card below the update log. Open by
 * default on desktop, closed on a phone. Rows are the project's activity-log
 * entries, newest first, shown 20 at a time with "Show older changes".
 *
 * The rows arrive already worded and time-zoned (lib/tracker/history.ts); this
 * component only handles the collapse and the paging.
 */
export default function PlanHistory({ items }: { items: HistoryItem[] }) {
  // Default open on desktop, closed on a phone. Start closed for SSR, then
  // open on mount when the viewport is wide, so the markup is stable.
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(PAGE_SIZE)

  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches) {
      setOpen(true)
    }
  }, [])

  const visible = items.slice(0, shown)
  const hasMore = shown < items.length

  return (
    <section className="rounded-xl border bg-card text-card-foreground shadow-sm">
      <h2 className="sr-only">History</h2>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="plan-history-body"
        className={cn(
          'flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left transition-colors hover:bg-muted/30',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        )}
      >
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200',
            open && 'rotate-180',
          )}
          aria-hidden="true"
        />
        <span className="flex-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          History
        </span>
      </button>

      {open && (
        <div id="plan-history-body" className="px-4 pb-4">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No history yet.</p>
          ) : (
            <>
              <ul className="space-y-3">
                {visible.map((it) => (
                  <li key={it.id} className="space-y-0.5 border-l-2 pl-3">
                    <div className="text-xs text-muted-foreground">{it.when}</div>
                    <p className="text-sm">
                      <span className="font-medium">{it.who}</span> {it.what}
                    </p>
                  </li>
                ))}
              </ul>
              {hasMore && (
                <button
                  type="button"
                  onClick={() => setShown((n) => n + PAGE_SIZE)}
                  className="mt-3 text-sm text-primary underline hover:no-underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  Show older changes
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
