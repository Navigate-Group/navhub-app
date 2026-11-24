'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatDate, daysBetweenISO } from '@/lib/tracker/view'

/**
 * My week (FR-4.4, FR-4.5) — client view.
 * ──────────────────────────────────────────────────────────────────────────
 * Shows the signed-in user everything assigned to them, sorted by when it's
 * due, so they can plan their week. The six summary tiles come from the
 * database view (tracker_v_action_counts); the grouped list and side columns
 * come from the shared myWeek() rule in lib/tracker/domain.ts — the page
 * computes both and passes them in, so My week always agrees with the rest of
 * the tracker.
 *
 * Each action card carries the quick buttons (Done, +1 day, +1 week, Waiting /
 * Back to me) which PATCH /api/tracker/actions/[id]. The assignee may use these
 * on their own action even without edit access to the project (the 082 action
 * guard allows it). After a change the page re-reads via router.refresh(), so
 * the action moves and the tiles update.
 */

export type MyWeekAction = {
  id: string
  title: string
  type: string | null
  typeLabel: string
  planId: string | null
  planName: string | null
  dueOn: string | null
  status: string
  who: string | null
  assigneeName: string | null
  waitingSince: string | null
}

export type MyWeekTiles = {
  overdue: number
  dueThisWeek: number
  waitingOnOthers: number
  callsAndEmails: number
  plansNeedingAttention: number
  closedThisWeek: number
}

export type MyWeekGroups = {
  overdue: MyWeekAction[]
  today: MyWeekAction[]
  restOfWeek: MyWeekAction[]
  nextWeek: MyWeekAction[]
  later: MyWeekAction[]
  noDate: MyWeekAction[]
  waiting: MyWeekAction[]
  calls: MyWeekAction[]
}

export type CallContactProject = { id: string; name: string }

/** An external contact on one of the user's projects, overdue for a call. */
export type CallContact = {
  id: string
  name: string
  org: string | null
  lastContact: string | null
  projects: CallContactProject[]
}

type Quick = 'done' | 'plus_day' | 'plus_week' | 'waiting' | 'back_to_me'

export default function MyWeek({
  tiles,
  groups,
  today,
  chaserDays,
  followUpDays,
  callContacts = [],
  currentUserId,
}: {
  tiles: MyWeekTiles
  groups: MyWeekGroups
  today: string
  chaserDays: number
  followUpDays: number
  callContacts?: CallContact[]
  currentUserId: string
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // "+ Call" from a contact: create a Call action due today on one of the
  // contact's projects. When there's more than one, a small picker asks which.
  const [callBusyId, setCallBusyId] = useState<string | null>(null)
  const [callError, setCallError] = useState<string | null>(null)
  const [pickProjectFor, setPickProjectFor] = useState<CallContact | null>(null)
  const [calledIds, setCalledIds] = useState<Set<string>>(new Set())

  async function createCall(c: CallContact, projectId: string) {
    setCallBusyId(c.id)
    setCallError(null)
    try {
      const res = await fetch('/api/tracker/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan_id: projectId,
          title: `Call ${c.name}`,
          type: 'call',
          status: 'open',
          due_on: today,
          assignee_id: currentUserId,
          contact_id: c.id,
        }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        setCallError(b.error || 'Could not create the call')
      } else {
        setPickProjectFor(null)
        setCalledIds((prev) => new Set(prev).add(c.id))
        startTransition(() => {
          router.refresh()
        })
      }
    } catch {
      setCallError('Could not create the call')
    } finally {
      setCallBusyId(null)
    }
  }

  function onAddCall(c: CallContact) {
    setCallError(null)
    if (c.projects.length === 0) return
    if (c.projects.length === 1) {
      void createCall(c, c.projects[0].id)
      return
    }
    setPickProjectFor(c)
  }

  const visibleCallContacts = callContacts.filter((c) => !calledIds.has(c.id))
  // Optimistically removed action ids: a quick button (Done, +1 day, +1 week,
  // Waiting, Back to me) moves the action out of its current bucket, so we hide
  // it from the lists straight away and let the quiet router.refresh() re-place
  // it. On failure we un-hide it and show the error.
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())

  async function quick(a: MyWeekAction, q: Quick) {
    setBusyId(a.id)
    setError(null)
    // Move the action out of its current list straight away.
    setHiddenIds((prev) => {
      const next = new Set(prev)
      next.add(a.id)
      return next
    })
    try {
      const res = await fetch(`/api/tracker/actions/${a.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quick: q }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        // Put the action back and show the error.
        setHiddenIds((prev) => {
          const next = new Set(prev)
          next.delete(a.id)
          return next
        })
        setError(body.error || 'Could not update the action')
      } else {
        // Re-read quietly so the action moves to its new bucket and the tiles
        // update, then drop the optimistic hide now the server rows agree. Both
        // run in one transition so the hide only clears once the fresh rows have
        // arrived — otherwise the action would briefly reappear in its old
        // bucket before moving. Plain (not async) callback: React 18 / Next 14
        // don't await it.
        startTransition(() => {
          router.refresh()
          setHiddenIds((prev) => {
            const next = new Set(prev)
            next.delete(a.id)
            return next
          })
        })
      }
    } catch {
      setHiddenIds((prev) => {
        const next = new Set(prev)
        next.delete(a.id)
        return next
      })
      setError('Could not update the action')
    } finally {
      setBusyId(null)
    }
  }

  // Hide optimistically-removed actions from every list until the quiet refresh
  // reconciles.
  const visibleGroups: MyWeekGroups = useMemo(() => {
    if (hiddenIds.size === 0) return groups
    const keep = (items: MyWeekAction[]) => items.filter((a) => !hiddenIds.has(a.id))
    return {
      overdue: keep(groups.overdue),
      today: keep(groups.today),
      restOfWeek: keep(groups.restOfWeek),
      nextWeek: keep(groups.nextWeek),
      later: keep(groups.later),
      noDate: keep(groups.noDate),
      waiting: keep(groups.waiting),
      calls: keep(groups.calls),
    }
  }, [groups, hiddenIds])

  const totalOpen =
    visibleGroups.overdue.length +
    visibleGroups.today.length +
    visibleGroups.restOfWeek.length +
    visibleGroups.nextWeek.length +
    visibleGroups.later.length +
    visibleGroups.noDate.length +
    visibleGroups.waiting.length

  const listGroups = useMemo(
    () => [
      { key: 'overdue', label: 'Overdue', items: visibleGroups.overdue, danger: true },
      { key: 'today', label: 'Today', items: visibleGroups.today, danger: false },
      { key: 'restOfWeek', label: 'Rest of this week', items: visibleGroups.restOfWeek, danger: false },
      { key: 'nextWeek', label: 'Next week', items: visibleGroups.nextWeek, danger: false },
      { key: 'later', label: 'Later', items: visibleGroups.later, danger: false },
      { key: 'noDate', label: 'No date yet', items: visibleGroups.noDate, danger: false },
    ],
    [visibleGroups],
  )

  return (
    <div className="space-y-6">
      {/* Six summary tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Overdue" value={tiles.overdue} tone={tiles.overdue > 0 ? 'red' : 'plain'} />
        <Tile label="Due this week" value={tiles.dueThisWeek} tone="plain" />
        <Tile label="Waiting on others" value={tiles.waitingOnOthers} tone="plain" />
        <Tile label="Calls & emails" value={tiles.callsAndEmails} tone="plain" />
        <Tile
          label="Plans needing attention"
          value={tiles.plansNeedingAttention}
          tone={tiles.plansNeedingAttention > 0 ? 'amber' : 'plain'}
        />
        <Tile label="Closed this week" value={tiles.closedThisWeek} tone="green" />
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {totalOpen === 0 && visibleCallContacts.length === 0 ? (
        <div className="rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
          <p className="text-sm text-muted-foreground">
            Nothing on your list. Actions assigned to you will appear here.
          </p>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          {/* My list */}
          <div className="space-y-6 lg:col-span-2">
            {listGroups.map((g) =>
              g.items.length === 0 ? null : (
                <section key={g.key} aria-label={g.label} className="space-y-2">
                  <h2
                    className={cn(
                      'text-sm font-semibold uppercase tracking-wide',
                      g.danger ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground',
                    )}
                  >
                    {g.label} · {g.items.length}
                  </h2>
                  <ul className="space-y-2">
                    {g.items.map((a) => (
                      <ActionCard
                        key={a.id}
                        action={a}
                        busy={busyId === a.id}
                        onQuick={quick}
                        overdue={g.danger}
                      />
                    ))}
                  </ul>
                </section>
              ),
            )}
          </div>

          {/* Side column: Waiting on others, Calls to make */}
          <aside className="space-y-6">
            <section aria-label="Waiting on others" className="space-y-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Waiting on others · {visibleGroups.waiting.length}
              </h2>
              {visibleGroups.waiting.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing waiting.</p>
              ) : (
                <ul className="space-y-2">
                  {visibleGroups.waiting.map((a) => (
                    <WaitingCard
                      key={a.id}
                      action={a}
                      today={today}
                      chaserDays={chaserDays}
                      busy={busyId === a.id}
                      onQuick={quick}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="Calls to make" className="space-y-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Calls to make · {visibleGroups.calls.length + visibleCallContacts.length}
              </h2>
              {callError && (
                <p className="text-sm text-destructive" role="alert">
                  {callError}
                </p>
              )}
              {visibleGroups.calls.length === 0 && visibleCallContacts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No calls to make.</p>
              ) : (
                <ul className="space-y-2">
                  {visibleGroups.calls.map((a) => (
                    <CallCard key={a.id} action={a} />
                  ))}
                  {visibleCallContacts.map((c) => (
                    <ContactCallCard
                      key={c.id}
                      contact={c}
                      today={today}
                      followUpDays={followUpDays}
                      busy={callBusyId === c.id}
                      onCall={() => onAddCall(c)}
                    />
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      )}

      {/* Project picker when a contact is on more than one of the user's projects */}
      <Dialog open={pickProjectFor !== null} onOpenChange={(o) => !o && setPickProjectFor(null)}>
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
                  disabled={callBusyId === pickProjectFor?.id}
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

function ContactCallCard({
  contact,
  today,
  followUpDays,
  busy,
  onCall,
}: {
  contact: CallContact
  today: string
  followUpDays: number
  busy: boolean
  onCall: () => void
}) {
  const days = contact.lastContact ? daysBetweenISO(contact.lastContact, today) : null
  const overdueLine =
    days == null ? 'Never contacted' : `Not spoken to for ${days} day${days === 1 ? '' : 's'}`
  return (
    <li className="space-y-1.5 rounded-xl border bg-card p-3 text-card-foreground shadow-sm">
      <div className="text-sm font-medium leading-snug">{contact.name}</div>
      <p className="text-xs text-muted-foreground">
        <span className={cn((days == null || days >= followUpDays) && 'font-medium text-red-600 dark:text-red-400')}>
          {overdueLine}
        </span>
        {contact.org && <span> · {contact.org}</span>}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" disabled={busy} onClick={onCall}>
          + Call
        </Button>
      </div>
    </li>
  )
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'plain' | 'red' | 'amber' | 'green'
}) {
  const toneClasses =
    tone === 'red'
      ? 'text-red-600 dark:text-red-400'
      : tone === 'amber'
        ? 'text-amber-600 dark:text-amber-400'
        : tone === 'green'
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-foreground'
  return (
    <div className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className={cn('text-2xl font-semibold tabular-nums', toneClasses)}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function ActionMeta({ action }: { action: MyWeekAction }) {
  const bits: string[] = []
  if (action.typeLabel) bits.push(action.typeLabel)
  if (action.planName) bits.push(action.planName)
  if (action.dueOn) bits.push(`due ${formatDate(action.dueOn)}`)
  const withWhom = action.assigneeName || action.who
  if (withWhom) bits.push(`with ${withWhom}`)
  return (
    <p className="text-xs text-muted-foreground">
      {bits.map((b, i) => (
        <span key={i}>
          {i > 0 && <span aria-hidden> · </span>}
          {b}
        </span>
      ))}
    </p>
  )
}

function ActionTitle({ action }: { action: MyWeekAction }) {
  if (action.planId) {
    return (
      <Link
        href={`/tracker/plans/${action.planId}`}
        className="text-sm font-medium leading-snug hover:underline"
      >
        {action.title}
      </Link>
    )
  }
  return <span className="text-sm font-medium leading-snug">{action.title}</span>
}

function QuickButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void
  disabled: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-7 items-center rounded-md border px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
    >
      {children}
    </button>
  )
}

function ActionCard({
  action,
  busy,
  onQuick,
  overdue,
}: {
  action: MyWeekAction
  busy: boolean
  onQuick: (a: MyWeekAction, q: Quick) => void
  overdue: boolean
}) {
  return (
    <li
      className={cn(
        'space-y-2 rounded-xl border bg-card p-3 text-card-foreground shadow-sm',
        overdue && 'border-red-300 dark:border-red-900/60',
      )}
    >
      <ActionTitle action={action} />
      <ActionMeta action={action} />
      <div className="flex flex-wrap gap-1.5">
        <QuickButton disabled={busy} onClick={() => onQuick(action, 'done')}>
          Done
        </QuickButton>
        <QuickButton disabled={busy} onClick={() => onQuick(action, 'plus_day')}>
          +1 day
        </QuickButton>
        <QuickButton disabled={busy} onClick={() => onQuick(action, 'plus_week')}>
          +1 week
        </QuickButton>
        <QuickButton disabled={busy} onClick={() => onQuick(action, 'waiting')}>
          Waiting
        </QuickButton>
      </div>
    </li>
  )
}

function WaitingCard({
  action,
  today,
  chaserDays,
  busy,
  onQuick,
}: {
  action: MyWeekAction
  today: string
  chaserDays: number
  busy: boolean
  onQuick: (a: MyWeekAction, q: Quick) => void
}) {
  const waitingDays = action.waitingSince ? daysBetweenISO(action.waitingSince, today) : 0
  const chaseNow = waitingDays > chaserDays
  const withWhom = action.assigneeName || action.who
  return (
    <li className="space-y-1.5 rounded-xl border bg-card p-3 text-card-foreground shadow-sm">
      <ActionTitle action={action} />
      <p className="text-xs text-muted-foreground">
        <span className={cn(chaseNow && 'font-medium text-red-600 dark:text-red-400')}>
          Waiting {waitingDays} day{waitingDays === 1 ? '' : 's'}
        </span>
        {chaseNow && <span className="font-medium text-red-600 dark:text-red-400"> · chase now</span>}
        {withWhom && <span> · with {withWhom}</span>}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <QuickButton disabled={busy} onClick={() => onQuick(action, 'back_to_me')}>
          Back to me
        </QuickButton>
      </div>
    </li>
  )
}

function CallCard({ action }: { action: MyWeekAction }) {
  const withWhom = action.assigneeName || action.who
  return (
    <li className="space-y-1 rounded-xl border bg-card p-3 text-card-foreground shadow-sm">
      <ActionTitle action={action} />
      <p className="text-xs text-muted-foreground">
        {withWhom && <span>{withWhom}</span>}
        {withWhom && action.planName && <span aria-hidden> · </span>}
        {action.planName && <span>{action.planName}</span>}
        {action.dueOn && (
          <span>
            {(withWhom || action.planName) && <span aria-hidden> · </span>}
            due {formatDate(action.dueOn)}
          </span>
        )}
      </p>
    </li>
  )
}
