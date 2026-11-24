'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { isoWeek, weekStartOf, addDays } from '@/lib/tracker/domain'

/**
 * Weekly review (FR-6) — client view.
 * ──────────────────────────────────────────────────────────────────────────
 * A private, personal weekly check-in: a checklist (the group's review steps),
 * a top three for next week, notes, an 8-week chart of actions I closed, and
 * the five health checks on my projects and actions.
 *
 * The numbers come from the database views (tracker_v_closed_per_week and
 * tracker_v_health_checks, migration 083), so they match the rest of the
 * tracker. Saving is one row per person per week (tracker_reviews); the DB
 * (082) only lets each person read and write their own, so another person can
 * never see my review. Ticks, top three and notes save automatically — ticks
 * straight away, text about a second after I stop typing — and come back when
 * I return to a week, including past weeks.
 *
 * Week navigation is client-side over the saved reviews the page already
 * loaded, so moving between weeks is instant; next week is disabled past the
 * current week. The chart is always the last 8 weeks up to today; the health
 * checks are a snapshot of now.
 */

export type ReviewStep = { key: string; label: string }

/** A saved review row for one week (this person only). */
export type SavedReview = {
  isoWeek: string
  checks: Record<string, boolean>
  top3: string | null
  notes: string | null
}

export type ClosedWeek = { isoWeek: string; closed: number }

/** An action I closed, for the chart drill-down. */
export type ClosedAction = {
  id: string
  title: string
  doneOn: string
  planId: string | null
  planName: string | null
}

export type HealthCheckRow = {
  key: 'noNextAction' | 'waitingTooLong' | 'needsStatusCheck' | 'noRecentUpdate' | 'noDueDate'
  label: string
  count: number
  /** The offending items: a plan (link to the project) or an action (link to its project). */
  items: { id: string; label: string; href: string | null }[]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "17–23 Nov" (or "28 Dec–3 Jan" across a month/year boundary). */
function weekDatesLabel(weekStartISO: string): string {
  const end = addDays(weekStartISO, 6)
  const [, sm, sd] = weekStartISO.split('-').map(Number)
  const [, em, ed] = end.split('-').map(Number)
  if (sm === em) return `${sd}–${ed} ${MONTHS[em - 1]}`
  return `${sd} ${MONTHS[sm - 1]}–${ed} ${MONTHS[em - 1]}`
}

/** A short bar label for an ISO week, e.g. "W47". */
function weekBarLabel(week: string): string {
  const w = week.split('-W')[1]
  return w ? `W${w}` : week
}

const DAY_LABEL: Record<string, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
}

export default function WeeklyReview({
  today,
  weekStart,
  reviewDay,
  steps,
  savedReviews,
  closedWeeks,
  closedActions,
  healthChecks,
}: {
  today: string
  weekStart: 'monday' | 'sunday'
  reviewDay: string
  steps: ReviewStep[]
  savedReviews: SavedReview[]
  closedWeeks: ClosedWeek[]
  closedActions: ClosedAction[]
  healthChecks: HealthCheckRow[]
}) {
  const currentWeekStart = useMemo(() => weekStartOf(today, weekStart), [today, weekStart])
  // The week being viewed, as the Monday/Sunday that starts it.
  const [viewWeekStart, setViewWeekStart] = useState(currentWeekStart)
  const viewWeek = useMemo(() => isoWeek(viewWeekStart), [viewWeekStart])
  const isCurrentWeek = viewWeekStart === currentWeekStart

  // Saved reviews keyed by ISO week, so returning to a week shows what I wrote.
  const savedByWeek = useMemo(() => {
    const m = new Map<string, SavedReview>()
    for (const r of savedReviews) m.set(r.isoWeek, r)
    return m
  }, [savedReviews])

  // Editable state for the week in view. Seeded from the saved row; re-seeded
  // whenever the week changes.
  const [checks, setChecks] = useState<Record<string, boolean>>({})
  const [top3, setTop3] = useState<string[]>(['', '', ''])
  const [notes, setNotes] = useState('')
  const [savedTick, setSavedTick] = useState(false)

  const seed = useCallback(
    (week: string) => {
      const row = savedByWeek.get(week)
      setChecks(row?.checks ?? {})
      const parts = (row?.top3 ?? '').split('\n')
      setTop3([parts[0] ?? '', parts[1] ?? '', parts[2] ?? ''])
      setNotes(row?.notes ?? '')
      setSavedTick(false)
    },
    [savedByWeek],
  )

  // Re-seed the editor when the viewed week changes.
  useEffect(() => {
    seed(viewWeek)
  }, [viewWeek, seed])

  // Persist a saved review back into the local map so navigating away and back
  // shows the latest without a round trip.
  const rememberSave = useCallback(
    (patch: Partial<SavedReview>) => {
      const existing = savedByWeek.get(viewWeek) ?? {
        isoWeek: viewWeek,
        checks: {},
        top3: null,
        notes: null,
      }
      savedByWeek.set(viewWeek, { ...existing, ...patch, isoWeek: viewWeek })
    },
    [savedByWeek, viewWeek],
  )

  const save = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        const res = await fetch('/api/tracker/reviews', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ iso_week: viewWeek, ...body }),
        })
        if (res.ok) {
          setSavedTick(true)
          window.setTimeout(() => setSavedTick(false), 2000)
        }
      } catch {
        // Leave the editor as-is; the user can try again by editing.
      }
    },
    [viewWeek],
  )

  // Checkboxes save straight away.
  function toggleStep(key: string) {
    setChecks((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      rememberSave({ checks: next })
      void save({ checks: next })
      return next
    })
  }

  // Top three and notes save about a second after typing stops (debounced).
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleTextSave = useCallback(
    (nextTop3: string[], nextNotes: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        const top3Str = nextTop3.join('\n').replace(/\n+$/, '') || null
        const notesStr = nextNotes.trim() === '' ? null : nextNotes
        rememberSave({ top3: top3Str, notes: notesStr })
        void save({ top3: top3Str, notes: notesStr })
      }, 1000)
    },
    [rememberSave, save],
  )

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  function onTop3Change(i: number, value: string) {
    setTop3((prev) => {
      const next = [...prev]
      next[i] = value
      scheduleTextSave(next, notes)
      return next
    })
  }

  function onNotesChange(value: string) {
    setNotes(value)
    scheduleTextSave(top3, value)
  }

  const checkedCount = steps.filter((s) => checks[s.key]).length
  const reviewDayLabel = DAY_LABEL[reviewDay] ?? 'Friday'

  // ── Chart ────────────────────────────────────────────────────────────────
  const chartData = useMemo(
    () => closedWeeks.map((w) => ({ week: w.isoWeek, label: weekBarLabel(w.isoWeek), closed: w.closed })),
    [closedWeeks],
  )
  const lastWeek = closedWeeks.length >= 2 ? closedWeeks[closedWeeks.length - 2].closed : 0
  const average = closedWeeks.length
    ? closedWeeks.reduce((s, w) => s + w.closed, 0) / closedWeeks.length
    : 0
  const totalClosed = closedWeeks.reduce((s, w) => s + w.closed, 0)
  const [selectedChartWeek, setSelectedChartWeek] = useState<string | null>(null)
  const closedActionsByWeek = useMemo(() => {
    const m = new Map<string, ClosedAction[]>()
    for (const a of closedActions) {
      const w = isoWeek(a.doneOn)
      const list = m.get(w) ?? []
      list.push(a)
      m.set(w, list)
    }
    return m
  }, [closedActions])
  const selectedWeekActions = selectedChartWeek
    ? closedActionsByWeek.get(selectedChartWeek) ?? []
    : []

  return (
    <div className="space-y-6">
      {/* Week navigation */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-foreground">{weekDatesLabel(viewWeekStart)}</span>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setViewWeekStart((w) => addDays(w, -7))}
          >
            ‹ previous week
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={isCurrentWeek}
            onClick={() => setViewWeekStart((w) => (w === currentWeekStart ? w : addDays(w, 7)))}
          >
            next week ›
          </Button>
          {!isCurrentWeek && (
            <Button size="sm" variant="ghost" onClick={() => setViewWeekStart(currentWeekStart)}>
              This week
            </Button>
          )}
        </div>
        {savedTick && (
          <span
            className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400"
            role="status"
          >
            Saved
          </span>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Checklist */}
        <section
          aria-label="Checklist"
          className="space-y-3 rounded-xl border bg-card p-4 text-card-foreground shadow-sm"
        >
          <h2 className="text-sm font-semibold">
            {reviewDayLabel} checklist · {checkedCount} of {steps.length}
          </h2>
          {steps.length === 0 ? (
            <p className="text-sm text-muted-foreground">No review steps set up.</p>
          ) : (
            <ul className="space-y-2">
              {steps.map((s) => (
                <li key={s.key}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!!checks[s.key]}
                      onChange={() => toggleStep(s.key)}
                      className="h-4 w-4 rounded border-input text-primary focus:ring-2 focus:ring-ring"
                    />
                    <span className={cn(checks[s.key] && 'text-muted-foreground line-through')}>
                      {s.label}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Top three + notes */}
        <section
          aria-label="Top three and notes"
          className="space-y-4 rounded-xl border bg-card p-4 text-card-foreground shadow-sm"
        >
          <div className="space-y-2">
            <h2 className="text-sm font-semibold">Top three for next week</h2>
            <ol className="space-y-2">
              {[0, 1, 2].map((i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground tabular-nums">{i + 1}.</span>
                  <input
                    type="text"
                    value={top3[i]}
                    onChange={(e) => onTop3Change(i, e.target.value)}
                    aria-label={`Top three item ${i + 1}`}
                    className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </li>
              ))}
            </ol>
          </div>
          <div className="space-y-2">
            <h2 className="text-sm font-semibold">Notes</h2>
            <textarea
              value={notes}
              onChange={(e) => onNotesChange(e.target.value)}
              aria-label="Notes"
              rows={5}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </section>
      </div>

      {/* Actions closed per week */}
      <section
        aria-label="Actions closed per week"
        className="space-y-3 rounded-xl border bg-card p-4 text-card-foreground shadow-sm"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Actions closed per week</h2>
          <p className="text-xs text-muted-foreground">
            Last week {lastWeek} · 8-week average {average.toFixed(1)}
          </p>
        </div>
        {totalClosed === 0 ? (
          <p className="text-sm text-muted-foreground">No actions closed yet.</p>
        ) : (
          <>
            <div className="h-48 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
                  onClick={(e) => {
                    const payload = (e as { activeLabel?: string } | null)?.activeLabel
                    const match = chartData.find((d) => d.label === payload)
                    if (match) setSelectedChartWeek((prev) => (prev === match.week ? null : match.week))
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: 'currentColor', opacity: 0.6 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 11, fill: 'currentColor', opacity: 0.6 }}
                    axisLine={false}
                    tickLine={false}
                    width={28}
                  />
                  <Tooltip
                    cursor={{ fill: 'currentColor', opacity: 0.05 }}
                    contentStyle={{ fontSize: 12 }}
                    formatter={(value) => [value as number, 'Closed']}
                  />
                  <Bar dataKey="closed" radius={[3, 3, 0, 0]} className="cursor-pointer">
                    {chartData.map((d) => (
                      <Cell
                        key={d.week}
                        fill={
                          d.week === selectedChartWeek
                            ? 'var(--primary, #0ea5e9)'
                            : 'currentColor'
                        }
                        fillOpacity={d.week === selectedChartWeek ? 1 : 0.4}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {selectedChartWeek && (
              <div className="space-y-1 border-t pt-3">
                <p className="text-xs font-medium text-muted-foreground">
                  Closed in {weekBarLabel(selectedChartWeek)} · {selectedWeekActions.length}
                </p>
                {selectedWeekActions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing closed that week.</p>
                ) : (
                  <ul className="space-y-1">
                    {selectedWeekActions.map((a) => (
                      <li key={a.id} className="text-sm">
                        {a.planId ? (
                          <Link href={`/tracker/plans/${a.planId}`} className="hover:underline">
                            {a.title}
                          </Link>
                        ) : (
                          <span>{a.title}</span>
                        )}
                        {a.planName && (
                          <span className="text-muted-foreground"> · {a.planName}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* Health checks */}
      <section
        aria-label="Health checks"
        className="space-y-2 rounded-xl border bg-card p-4 text-card-foreground shadow-sm"
      >
        <h2 className="text-sm font-semibold">Health checks</h2>
        <ul className="divide-y">
          {healthChecks.map((hc) => (
            <HealthCheckItem key={hc.key} row={hc} />
          ))}
        </ul>
      </section>
    </div>
  )
}

function HealthCheckItem({ row }: { row: HealthCheckRow }) {
  const [open, setOpen] = useState(false)
  const bad = row.count > 0
  return (
    <li>
      <button
        type="button"
        onClick={() => bad && setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center justify-between gap-3 py-2 text-left text-sm',
          bad ? 'cursor-pointer' : 'cursor-default',
        )}
        aria-expanded={bad ? open : undefined}
      >
        <span>{row.label}</span>
        <span
          className={cn(
            'inline-flex min-w-6 justify-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums',
            bad
              ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {row.count}
        </span>
      </button>
      {bad && open && (
        <ul className="space-y-1 pb-2 pl-1">
          {row.items.map((it) => (
            <li key={it.id} className="text-sm">
              {it.href ? (
                <Link href={it.href} className="hover:underline">
                  {it.label}
                </Link>
              ) : (
                <span>{it.label}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
