'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { formatDate, daysBetweenISO, statusDotClasses } from '@/lib/tracker/view'
import BriefingAgent from '@/components/tracker/BriefingAgent'

/**
 * My Summary (reworked My week) — client view.
 * ──────────────────────────────────────────────────────────────────────────
 * Shows the signed-in person the open items on *their* projects (owner, lead,
 * member or Comment/Edit access) plus any open items assigned to them on other
 * projects, grouped into working-day date bands. The page computes the bands,
 * tiles and permissions with the shared rules in lib/tracker/domain.ts and
 * passes them in, so the tiles and the list always agree.
 *
 * Two views (List, By project) and a range (7 / 14 / 30 working days) are
 * remembered in localStorage. Each row's quick buttons (Done, +1 day, +1 week,
 * Waiting / Back to me) PATCH /api/tracker/actions/[id] with the same instant
 * (optimistic hide → quiet router.refresh) pattern My week used before — the
 * action moves to its new band and the tiles update with no page jump.
 */

export type SummaryItem = {
  id: string
  title: string
  type: string | null
  typeLabel: string
  planId: string | null
  planName: string | null
  /** Status key of the item's project (for the small status dot). */
  planStatus: string | null
  /** Whether the person can open the project (RLS need-to-know). */
  planLinkable: boolean
  dueOn: string | null
  status: string
  who: string | null
  assigneeName: string | null
  waitingSince: string | null
  /** Whether the quick buttons may be used on this item by this person. */
  canAct: boolean
}

export type SummaryTilesView = {
  overdue: number
  dueNext7: number
  waitingOnOthers: number
  projectsNeedingAttention: number
  closedThisWeek: number
}

export type BandKey = 'overdue' | 'next7' | 'days8to14' | 'days15to30' | 'noDate'

export type SummaryGroups = {
  overdue: SummaryItem[]
  next7: SummaryItem[]
  days8to14: SummaryItem[]
  days15to30: SummaryItem[]
  noDate: SummaryItem[]
  waiting: SummaryItem[]
}

/** Inclusive band end dates, so each section can show its date range. */
export type BandBounds = {
  today: string
  dayOne: string
  end7: string
  end14: string
  end30: string
}

type Quick = 'done' | 'plus_day' | 'plus_week' | 'waiting' | 'back_to_me'
type View = 'list' | 'project'
type Range = 7 | 14 | 30

const VIEW_KEY = 'tracker.mySummary.view'
const RANGE_KEY = 'tracker.mySummary.range'

/** The band keys included for a given range (excludes noDate + waiting). */
function bandsForRange(range: Range): BandKey[] {
  if (range === 7) return ['overdue', 'next7']
  if (range === 14) return ['overdue', 'next7', 'days8to14']
  return ['overdue', 'next7', 'days8to14', 'days15to30']
}

function bandLabel(key: BandKey): string {
  switch (key) {
    case 'overdue':
      return 'Overdue'
    case 'next7':
      return 'Next 7 working days'
    case 'days8to14':
      return 'Working days 8–14'
    case 'days15to30':
      return 'Working days 15–30'
    case 'noDate':
      return 'No date'
  }
}

/** The date-range suffix for a band header, e.g. "25 Nov – 3 Dec". */
function bandDateRange(key: BandKey, b: BandBounds): string | null {
  switch (key) {
    case 'next7':
      return `${formatDate(b.dayOne)} – ${formatDate(b.end7)}`
    case 'days8to14':
      return `${formatDate(nextDay(b.end7))} – ${formatDate(b.end14)}`
    case 'days15to30':
      return `${formatDate(nextDay(b.end14))} – ${formatDate(b.end30)}`
    default:
      return null
  }
}

function nextDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const ms = Date.UTC(y, m - 1, d) + 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

export default function MySummary({
  tiles,
  groups,
  bounds,
  today,
  chaserDays,
}: {
  tiles: SummaryTilesView
  groups: SummaryGroups
  bounds: BandBounds
  today: string
  chaserDays: number
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())

  // View + range, remembered in the browser. Start with the defaults for SSR,
  // then hydrate from localStorage so the first paint matches the server.
  const [view, setView] = useState<View>('list')
  const [range, setRange] = useState<Range>(7)
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(VIEW_KEY)
      if (v === 'list' || v === 'project') setView(v)
      const r = Number(window.localStorage.getItem(RANGE_KEY))
      if (r === 7 || r === 14 || r === 30) setRange(r)
    } catch {
      /* storage unavailable — keep defaults */
    }
  }, [])
  function chooseView(v: View) {
    setView(v)
    try {
      window.localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* ignore */
    }
  }
  function chooseRange(r: Range) {
    setRange(r)
    try {
      window.localStorage.setItem(RANGE_KEY, String(r))
    } catch {
      /* ignore */
    }
  }

  async function quick(a: SummaryItem, q: Quick) {
    setBusyId(a.id)
    setError(null)
    setHiddenIds((prev) => new Set(prev).add(a.id))
    try {
      const res = await fetch(`/api/tracker/actions/${a.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quick: q }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setHiddenIds((prev) => {
          const next = new Set(prev)
          next.delete(a.id)
          return next
        })
        setError(body.error || 'Could not update the action')
      } else {
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

  // Hide optimistically-removed items from every list until the quiet refresh
  // reconciles.
  const visibleGroups: SummaryGroups = useMemo(() => {
    if (hiddenIds.size === 0) return groups
    const keep = (items: SummaryItem[]) => items.filter((a) => !hiddenIds.has(a.id))
    return {
      overdue: keep(groups.overdue),
      next7: keep(groups.next7),
      days8to14: keep(groups.days8to14),
      days15to30: keep(groups.days15to30),
      noDate: keep(groups.noDate),
      waiting: keep(groups.waiting),
    }
  }, [groups, hiddenIds])

  const activeBands = bandsForRange(range)

  const itemsInRange = useMemo(() => {
    const out: SummaryItem[] = []
    for (const key of activeBands) out.push(...visibleGroups[key])
    return out
  }, [visibleGroups, activeBands])

  const noDateCount = visibleGroups.noDate.length

  return (
    <div className="space-y-6">
      {/* Five summary tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Tile label="Overdue" value={tiles.overdue} tone={tiles.overdue > 0 ? 'red' : 'plain'} />
        <Tile label="Due in next 7 working days" value={tiles.dueNext7} tone="plain" />
        <Tile label="Waiting on others" value={tiles.waitingOnOthers} tone="plain" />
        <Tile
          label="Projects needing attention"
          value={tiles.projectsNeedingAttention}
          tone={tiles.projectsNeedingAttention > 0 ? 'amber' : 'plain'}
        />
        <Tile label="Closed this week" value={tiles.closedThisWeek} tone="green" />
      </div>

      {/* The Briefing agent's "Brief me" box, between the tiles and My open
          items / My projects. It self-contains its conversation and apply flow
          and refreshes the page quietly after changes are applied. */}
      <BriefingAgent />

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {/* My open items */}
      <section aria-label="My open items" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">My open items</h2>
          <div className="flex flex-wrap items-center gap-4">
            <Segmented
              ariaLabel="View"
              options={[
                { value: 'list', label: 'List' },
                { value: 'project', label: 'By project' },
              ]}
              value={view}
              onChange={(v) => chooseView(v as View)}
            />
            <Segmented
              ariaLabel="Range"
              options={[
                { value: '7', label: 'Next 7' },
                { value: '14', label: 'Next 14' },
                { value: '30', label: 'Next 30' },
              ]}
              value={String(range)}
              onChange={(v) => chooseRange(Number(v) as Range)}
              suffix="working days"
            />
          </div>
        </div>

        {itemsInRange.length === 0 ? (
          <div className="rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
            <p className="text-sm text-muted-foreground">
              No open items on your projects in the next {range} working days.
            </p>
          </div>
        ) : view === 'list' ? (
          <ListView
            groups={visibleGroups}
            bands={activeBands}
            bounds={bounds}
            busyId={busyId}
            onQuick={quick}
            noDateCount={noDateCount}
          />
        ) : (
          <ByProjectView
            groups={visibleGroups}
            bands={activeBands}
            bounds={bounds}
            busyId={busyId}
            onQuick={quick}
          />
        )}
      </section>

      {/* Waiting on others, at the bottom */}
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
    </div>
  )
}

// ── List view ────────────────────────────────────────────────────────────────

function ListView({
  groups,
  bands,
  bounds,
  busyId,
  onQuick,
  noDateCount,
}: {
  groups: SummaryGroups
  bands: BandKey[]
  bounds: BandBounds
  busyId: string | null
  onQuick: (a: SummaryItem, q: Quick) => void
  noDateCount: number
}) {
  return (
    <div className="space-y-6">
      {bands.map((key) => {
        const items = groups[key]
        if (items.length === 0) return null
        const danger = key === 'overdue'
        const range = bandDateRange(key, bounds)
        return (
          <section key={key} aria-label={bandLabel(key)} className="space-y-2">
            <h3
              className={cn(
                'text-sm font-semibold uppercase tracking-wide',
                danger ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground',
              )}
            >
              {bandLabel(key)}
              {range && <span className="font-normal normal-case"> · {range}</span>}
              <span className="font-normal"> · {items.length}</span>
            </h3>
            <ul className="divide-y rounded-xl border bg-card text-card-foreground shadow-sm">
              {items.map((a) => (
                <ListRow key={a.id} action={a} busy={busyId === a.id} onQuick={onQuick} danger={danger} />
              ))}
            </ul>
          </section>
        )
      })}
      {noDateCount > 0 && (
        <p className="text-sm text-muted-foreground">
          {noDateCount} open item{noDateCount === 1 ? ' has' : 's have'} no due date; switch to By
          project to see {noDateCount === 1 ? 'it' : 'them'}.
        </p>
      )}
    </div>
  )
}

function ListRow({
  action,
  busy,
  onQuick,
  danger,
}: {
  action: SummaryItem
  busy: boolean
  onQuick: (a: SummaryItem, q: Quick) => void
  danger: boolean
}) {
  const withWhom = action.assigneeName || action.who
  return (
    <li
      className={cn(
        'flex flex-col gap-3 p-3 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)] sm:items-start sm:gap-4',
        danger && 'bg-red-50/50 dark:bg-red-950/10',
      )}
    >
      {/* Project */}
      <div className="flex items-center gap-2">
        <span
          className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-full', statusDotClasses(action.planStatus))}
          aria-hidden
        />
        <ProjectName action={action} />
      </div>
      {/* Open item */}
      <div className="min-w-0">
        <ItemTitle action={action} />
        {action.typeLabel && <p className="text-xs text-muted-foreground">{action.typeLabel}</p>}
      </div>
      {/* Due · who + buttons */}
      <div className="space-y-1.5 sm:text-right">
        <p className="text-xs text-muted-foreground">
          {action.dueOn ? `Due ${formatDate(action.dueOn)}` : 'No due date'}
          {withWhom && <span> · {withWhom}</span>}
        </p>
        {action.canAct && (
          <div className="flex flex-wrap gap-1.5 sm:justify-end">
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
        )}
      </div>
    </li>
  )
}

// ── By project view ──────────────────────────────────────────────────────────

type ProjectGroup = {
  planId: string | null
  planName: string
  planStatus: string | null
  planLinkable: boolean
  overdueCount: number
  next7Count: number
  earliestDue: string | null
  /** Items in this project by band (only the active range bands + noDate). */
  byBand: Record<BandKey, SummaryItem[]>
}

function ByProjectView({
  groups,
  bands,
  bounds,
  busyId,
  onQuick,
}: {
  groups: SummaryGroups
  bands: BandKey[]
  bounds: BandBounds
  busyId: string | null
  onQuick: (a: SummaryItem, q: Quick) => void
}) {
  // The By project view also shows No date items for each project.
  const shownBands: BandKey[] = [...bands, 'noDate']

  const projects = useMemo(() => {
    const map = new Map<string, ProjectGroup>()
    const keyOf = (a: SummaryItem) => a.planId ?? '__none__'
    for (const band of shownBands) {
      for (const a of groups[band]) {
        const k = keyOf(a)
        let g = map.get(k)
        if (!g) {
          g = {
            planId: a.planId,
            planName: a.planName ?? 'No project',
            planStatus: a.planStatus,
            planLinkable: a.planLinkable,
            overdueCount: 0,
            next7Count: 0,
            earliestDue: null,
            byBand: { overdue: [], next7: [], days8to14: [], days15to30: [], noDate: [] },
          }
          map.set(k, g)
        }
        g.byBand[band].push(a)
        if (band === 'overdue') g.overdueCount++
        if (band === 'next7') g.next7Count++
        if (a.dueOn && (g.earliestDue === null || a.dueOn < g.earliestDue)) g.earliestDue = a.dueOn
      }
    }
    // Most urgent first: by overdue count, then earliest due date.
    return Array.from(map.values()).sort((a, b) => {
      if (a.overdueCount !== b.overdueCount) return b.overdueCount - a.overdueCount
      const ad = a.earliestDue ?? '9999-12-31'
      const bd = b.earliestDue ?? '9999-12-31'
      return ad < bd ? -1 : ad > bd ? 1 : a.planName.localeCompare(b.planName)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, bands.join(',')])

  // Expanded projects and expanded bands within them. Projects collapsed by
  // default; Overdue and Next 7 start open inside an expanded project.
  const [openProjects, setOpenProjects] = useState<Set<string>>(new Set())
  const [collapsedBands, setCollapsedBands] = useState<Set<string>>(new Set())

  const projectKey = (g: ProjectGroup) => g.planId ?? '__none__'

  function toggleProject(k: string) {
    setOpenProjects((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }
  function expandAll() {
    setOpenProjects(new Set(projects.map(projectKey)))
    setCollapsedBands(new Set())
  }
  function collapseAll() {
    setOpenProjects(new Set())
  }
  const bandIsOpen = (pk: string, band: BandKey) => {
    const startOpen = band === 'overdue' || band === 'next7'
    const token = `${pk}:${band}`
    return startOpen ? !collapsedBands.has(token) : collapsedBands.has(token)
  }
  function toggleBand(pk: string, band: BandKey) {
    const token = `${pk}:${band}`
    setCollapsedBands((prev) => {
      const next = new Set(prev)
      if (next.has(token)) next.delete(token)
      else next.add(token)
      return next
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={expandAll}
          className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted"
        >
          Expand all
        </button>
        <button
          type="button"
          onClick={collapseAll}
          className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted"
        >
          Collapse all
        </button>
      </div>

      <ul className="space-y-2">
        {projects.map((g) => {
          const pk = projectKey(g)
          const open = openProjects.has(pk)
          const counts: string[] = []
          if (g.overdueCount > 0) counts.push(`${g.overdueCount} overdue`)
          if (g.next7Count > 0) counts.push(`${g.next7Count} in next 7 working days`)
          return (
            <li key={pk} className="rounded-xl border bg-card text-card-foreground shadow-sm">
              <button
                type="button"
                onClick={() => toggleProject(pk)}
                aria-expanded={open}
                className="flex w-full items-center gap-3 p-3 text-left"
              >
                <span
                  className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-full', statusDotClasses(g.planStatus))}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="text-sm font-medium">{g.planName}</span>
                  {counts.length > 0 && (
                    <span className="ml-2 text-xs text-muted-foreground">{counts.join(' · ')}</span>
                  )}
                </span>
                <span aria-hidden className="text-muted-foreground">
                  {open ? '▾' : '▸'}
                </span>
              </button>
              {open && (
                <div className="space-y-3 border-t p-3">
                  {g.planId && g.planLinkable && (
                    <Link
                      href={`/tracker/plans/${g.planId}`}
                      className="inline-block text-xs font-medium text-primary hover:underline"
                    >
                      Open project →
                    </Link>
                  )}
                  {shownBands.map((band) => {
                    const items = g.byBand[band]
                    if (items.length === 0) return null
                    const bandOpen = bandIsOpen(pk, band)
                    const range = bandDateRange(band, bounds)
                    return (
                      <div key={band} className="space-y-2">
                        <button
                          type="button"
                          onClick={() => toggleBand(pk, band)}
                          aria-expanded={bandOpen}
                          className={cn(
                            'flex w-full items-center gap-1 text-left text-xs font-semibold uppercase tracking-wide',
                            band === 'overdue' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground',
                          )}
                        >
                          <span aria-hidden>{bandOpen ? '▾' : '▸'}</span>
                          {bandLabel(band)}
                          {range && <span className="font-normal normal-case"> · {range}</span>}
                          <span className="font-normal"> · {items.length}</span>
                        </button>
                        {bandOpen && (
                          <ul className="divide-y rounded-lg border">
                            {items.map((a) => (
                              <ListRow
                                key={a.id}
                                action={a}
                                busy={busyId === a.id}
                                onQuick={onQuick}
                                danger={band === 'overdue'}
                              />
                            ))}
                          </ul>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ── Shared bits ──────────────────────────────────────────────────────────────

function Segmented({
  ariaLabel,
  options,
  value,
  onChange,
  suffix,
}: {
  ariaLabel: string
  options: { value: string; label: string }[]
  value: string
  onChange: (v: string) => void
  suffix?: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">{ariaLabel}</span>
      <div role="group" aria-label={ariaLabel} className="inline-flex rounded-md border p-0.5">
        {options.map((o) => {
          const active = o.value === value
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(o.value)}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {o.label}
            </button>
          )
        })}
      </div>
      {suffix && <span className="hidden text-xs text-muted-foreground sm:inline">{suffix}</span>}
    </div>
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

function ProjectName({ action }: { action: SummaryItem }) {
  const name = action.planName ?? 'No project'
  if (action.planId && action.planLinkable) {
    return (
      <Link href={`/tracker/plans/${action.planId}`} className="text-sm font-medium hover:underline">
        {name}
      </Link>
    )
  }
  return <span className="text-sm font-medium">{name}</span>
}

function ItemTitle({ action }: { action: SummaryItem }) {
  if (action.planId && action.planLinkable) {
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

function WaitingCard({
  action,
  today,
  chaserDays,
  busy,
  onQuick,
}: {
  action: SummaryItem
  today: string
  chaserDays: number
  busy: boolean
  onQuick: (a: SummaryItem, q: Quick) => void
}) {
  const waitingDays = action.waitingSince ? daysBetweenISO(action.waitingSince, today) : 0
  const chaseNow = waitingDays > chaserDays
  const withWhom = action.assigneeName || action.who
  return (
    <li className="space-y-1.5 rounded-xl border bg-card p-3 text-card-foreground shadow-sm">
      <div className="flex items-center gap-2">
        <span
          className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-full', statusDotClasses(action.planStatus))}
          aria-hidden
        />
        <ItemTitle action={action} />
      </div>
      <p className="text-xs text-muted-foreground">
        {action.planName && <span>{action.planName} · </span>}
        <span className={cn(chaseNow && 'font-medium text-red-600 dark:text-red-400')}>
          Waiting {waitingDays} day{waitingDays === 1 ? '' : 's'}
        </span>
        {chaseNow && <span className="font-medium text-red-600 dark:text-red-400"> · chase now</span>}
        {withWhom && <span> · with {withWhom}</span>}
      </p>
      {action.canAct && (
        <div className="flex flex-wrap gap-1.5">
          <QuickButton disabled={busy} onClick={() => onQuick(action, 'back_to_me')}>
            Back to me
          </QuickButton>
        </div>
      )}
    </li>
  )
}
