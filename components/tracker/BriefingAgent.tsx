'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  briefErrorMessage,
  type BriefMessage,
  type BriefTurn,
  type ProposedChangeItem,
  type ApplyResult,
} from '@/lib/tracker/brief'

/**
 * Briefing agent — the "Brief me" box on My Summary.
 * ──────────────────────────────────────────────────────────────────────────
 * The person types what happened; the agent (POST /api/tracker/brief) works out
 * which projects/milestones/actions/updates/contacts it affects, asks one short
 * question at a time when unclear, and finally shows a "Proposed changes" card.
 * Nothing is saved until Apply (POST /api/tracker/brief/apply), which validates
 * and writes through the person's own server client, so the tracker's access
 * rules decide. After applying, My Summary refreshes quietly.
 *
 * If the AI service is unavailable the box shows the agreed fallback line and
 * the rest of the page keeps working.
 */

const UNAVAILABLE =
  "The Briefing agent isn't available right now. You can still update projects as usual."

const HINT =
  "Tell me what happened, for example: \u201CSpoke to Pat at the co-op today. NSW sign-off slips to 5 Dec, chase him Monday. QLD install is finished.\u201D"

type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'message'; text: string }
  | { kind: 'question'; text: string; options: string[]; answered: boolean }
  | {
      kind: 'proposal'
      intro: string | null
      changes: ProposedChangeItem[]
      ticked: Set<string>
      state: 'pending' | 'applying' | 'applied' | 'cancelled'
      results: Record<string, ApplyResult>
    }

export default function BriefingAgent() {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [input, setInput] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Build the running chat the server expects: user turns plus a compact
  // assistant echo for questions/messages so the model keeps context.
  function chatFromEntries(list: Entry[]): BriefMessage[] {
    const out: BriefMessage[] = []
    for (const e of list) {
      if (e.kind === 'user') out.push({ role: 'user', content: e.text })
      else if (e.kind === 'message') out.push({ role: 'assistant', content: e.text })
      else if (e.kind === 'question') out.push({ role: 'assistant', content: e.text })
      else if (e.kind === 'proposal')
        out.push({ role: 'assistant', content: '(proposed changes)' })
    }
    return out
  }

  async function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || sending) return
    setError(null)
    const nextEntries: Entry[] = [...entries, { kind: 'user', text: trimmed }]
    setEntries(nextEntries)
    setInput('')
    setSending(true)
    scrollSoon()

    try {
      const res = await fetch('/api/tracker/brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: chatFromEntries(nextEntries) }),
      })
      if (!res.ok) {
        // The route encodes a specific failure reason (timeout, credit,
        // rate-limit, no-key, error); show the matching message, falling back
        // to the generic line when the body can't be read or has no reason.
        let reason: string | null = null
        try {
          const body = (await res.json()) as { reason?: string }
          reason = body.reason ?? null
        } catch {
          /* no body — use the generic fallback */
        }
        setError(briefErrorMessage(reason))
        return
      }
      const { turn } = (await res.json()) as { turn: BriefTurn }
      setEntries((prev) => [...prev, entryFromTurn(turn)])
    } catch {
      setError(UNAVAILABLE)
    } finally {
      setSending(false)
      scrollSoon()
    }
  }

  function entryFromTurn(turn: BriefTurn): Entry {
    if (turn.type === 'question')
      return { kind: 'question', text: turn.text, options: turn.options, answered: false }
    if (turn.type === 'proposal')
      return {
        kind: 'proposal',
        intro: turn.intro,
        changes: turn.changes,
        ticked: new Set(turn.changes.map((c) => c.id)),
        state: 'pending',
        results: {},
      }
    if (turn.type === 'error') return { kind: 'message', text: UNAVAILABLE }
    // Both 'message' and 'answer' are plain assistant text (an answer is a reply
    // to a question — nothing is saved); show them the same way.
    return { kind: 'message', text: turn.text }
  }

  function scrollSoon() {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    })
  }

  function answerQuestion(index: number, answer: string) {
    setEntries((prev) =>
      prev.map((e, i) => (i === index && e.kind === 'question' ? { ...e, answered: true } : e)),
    )
    void send(answer)
  }

  function toggleLine(index: number, lineId: string) {
    setEntries((prev) =>
      prev.map((e, i) => {
        if (i !== index || e.kind !== 'proposal' || e.state !== 'pending') return e
        const ticked = new Set(e.ticked)
        if (ticked.has(lineId)) ticked.delete(lineId)
        else ticked.add(lineId)
        return { ...e, ticked }
      }),
    )
  }

  async function apply(index: number) {
    const entry = entries[index]
    if (!entry || entry.kind !== 'proposal' || entry.state !== 'pending') return
    const toApply = entry.changes.filter((c) => entry.ticked.has(c.id))
    if (toApply.length === 0) return

    setEntries((prev) =>
      prev.map((e, i) => (i === index && e.kind === 'proposal' ? { ...e, state: 'applying' } : e)),
    )
    try {
      const res = await fetch('/api/tracker/brief/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: toApply }),
      })
      if (!res.ok) {
        setEntries((prev) =>
          prev.map((e, i) => (i === index && e.kind === 'proposal' ? { ...e, state: 'pending' } : e)),
        )
        setError('The changes could not be applied. Please try again.')
        return
      }
      const { results } = (await res.json()) as { results: ApplyResult[] }
      const byId: Record<string, ApplyResult> = {}
      for (const r of results) byId[r.id] = r
      setEntries((prev) =>
        prev.map((e, i) =>
          i === index && e.kind === 'proposal' ? { ...e, state: 'applied', results: byId } : e,
        ),
      )
      // Quiet refresh so the tiles, My projects and lists reflect the changes.
      startTransition(() => router.refresh())
    } catch {
      setEntries((prev) =>
        prev.map((e, i) => (i === index && e.kind === 'proposal' ? { ...e, state: 'pending' } : e)),
      )
      setError('The changes could not be applied. Please try again.')
    } finally {
      scrollSoon()
    }
  }

  function cancel(index: number) {
    setEntries((prev) =>
      prev.map((e, i) =>
        i === index && e.kind === 'proposal' ? { ...e, state: 'cancelled' } : e,
      ),
    )
  }

  function newBriefing() {
    setEntries([])
    setInput('')
    setError(null)
  }

  const hasConversation = entries.length > 0

  return (
    <section
      aria-label="Brief me"
      className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Brief me</h2>
        {hasConversation && (
          <button
            type="button"
            onClick={newBriefing}
            className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted"
          >
            New briefing
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{HINT}</p>

      <form
        className="mt-3 space-y-2"
        onSubmit={(e) => {
          e.preventDefault()
          void send(input)
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void send(input)
            }
          }}
          rows={3}
          placeholder="Tell me what happened…"
          disabled={sending}
          className="w-full resize-y rounded-lg border bg-background p-2.5 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {sending ? 'Thinking…' : 'Nothing is saved until you press Apply.'}
          </span>
          <button
            type="submit"
            disabled={sending || input.trim() === ''}
            className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>

      {error && (
        <p className="mt-3 text-sm text-amber-700 dark:text-amber-400" role="status">
          {error}
        </p>
      )}

      {hasConversation && (
        <div ref={scrollRef} className="mt-4 max-h-[28rem] space-y-3 overflow-y-auto pr-1">
          {entries.map((e, i) => (
            <EntryView
              key={i}
              entry={e}
              onAnswer={(answer) => answerQuestion(i, answer)}
              onToggleLine={(lineId) => toggleLine(i, lineId)}
              onApply={() => apply(i)}
              onCancel={() => cancel(i)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

// ── Entry views ──────────────────────────────────────────────────────────────

function EntryView({
  entry,
  onAnswer,
  onToggleLine,
  onApply,
  onCancel,
}: {
  entry: Entry
  onAnswer: (answer: string) => void
  onToggleLine: (lineId: string) => void
  onApply: () => void
  onCancel: () => void
}) {
  if (entry.kind === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
          {entry.text}
        </p>
      </div>
    )
  }

  if (entry.kind === 'message') {
    return (
      <p className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm">
        {entry.text}
      </p>
    )
  }

  if (entry.kind === 'question') {
    return (
      <div
        className={cn(
          'max-w-[90%] space-y-2 rounded-lg border p-3',
          entry.answered
            ? 'border-border bg-muted/20 opacity-60'
            : 'border-amber-400/50 bg-amber-50 dark:bg-amber-950/20',
        )}
      >
        <p className="text-sm font-medium">{entry.text}</p>
        {entry.options.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {entry.options.map((opt) => (
              <button
                key={opt}
                type="button"
                disabled={entry.answered}
                onClick={() => onAnswer(opt)}
                className="rounded-md border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:pointer-events-none disabled:opacity-60"
              >
                {opt}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  // proposal
  const { intro, changes, ticked, state, results } = entry
  const applied = state === 'applied'
  const cancelled = state === 'cancelled'
  const applying = state === 'applying'
  return (
    <div className="space-y-2 rounded-lg border bg-background p-3 shadow-sm">
      <h3 className="text-sm font-semibold">Proposed changes</h3>
      {intro && <p className="text-xs text-muted-foreground">{intro}</p>}
      {changes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No changes to propose.</p>
      ) : (
        <ul className="space-y-1.5">
          {changes.map((c) => {
            const result = results[c.id]
            return (
              <li key={c.id} className="flex items-start gap-2 text-sm">
                {applied || cancelled ? (
                  <span className="mt-0.5 w-4 shrink-0 text-center" aria-hidden>
                    {result ? (result.ok ? '✓' : '✕') : ''}
                  </span>
                ) : (
                  <input
                    type="checkbox"
                    checked={ticked.has(c.id)}
                    onChange={() => onToggleLine(c.id)}
                    disabled={applying}
                    className="mt-0.5 h-4 w-4 shrink-0"
                    aria-label={c.label}
                  />
                )}
                <span className={cn('min-w-0', result && !result.ok && 'text-muted-foreground')}>
                  {c.label}
                  {applied && result && (
                    <span
                      className={cn(
                        'ml-1 text-xs',
                        result.ok
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-red-600 dark:text-red-400',
                      )}
                    >
                      {result.ok ? '✓ done' : `✕ ${result.error ?? 'failed'}`}
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {state === 'pending' && changes.length > 0 && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={onApply}
            disabled={ticked.size === 0}
            className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted"
          >
            Cancel
          </button>
        </div>
      )}
      {applying && <p className="text-xs text-muted-foreground">Applying…</p>}
      {cancelled && <p className="text-xs text-muted-foreground">Cancelled — nothing was saved.</p>}
    </div>
  )
}
