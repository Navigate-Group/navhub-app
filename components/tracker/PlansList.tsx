'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { FolderKanban } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { ToggleSwitch } from '@/components/ui/toggle-switch'
import {
  type Lookups,
  lookupLabel,
  formatDate,
  daysBetweenISO,
} from '@/lib/tracker/view'
import StatusLabel from '@/components/tracker/StatusLabel'
import { cn } from '@/lib/utils'

export type PlanListItem = {
  id: string
  name: string
  client: string | null
  phase: string | null
  region: string | null
  category: string | null
  status: string | null
  archived: boolean
  isActive: boolean
  lastUpdated: string | null
  openActions: number
  subPlans: number
  needsAttention: boolean
  nextActionTitle: string | null
  nextActionDue: string | null
  flagStatus: boolean
  flagNoOpenAction: boolean
  flagOverdueAction: boolean
  flagStale: boolean
  nextMilestoneTitle: string | null
  nextMilestoneDone: number | null
  nextMilestoneTotal: number | null
  nextMilestonePct: number | null
  /** Whether the next milestone's progress is counted from its linked actions. */
  nextMilestoneFromActions: boolean
  /** The project's own progress field (shown when there's no upcoming milestone). */
  planProgressPct: number
}

type Filter = 'active' | 'attention' | 'all'

export default function PlansList({
  items,
  lookups,
  today,
  isEditor,
  hideHeader = false,
}: {
  items: PlanListItem[]
  lookups: Lookups
  today: string
  isEditor: boolean
  /** When the page already renders the title + buttons (TrackerHeader), omit the
   *  internal header so the title is not shown twice (design spec: the tabs sit
   *  below the page title). */
  hideHeader?: boolean
}) {
  const [filter, setFilter] = useState<Filter>('active')
  const [showArchived, setShowArchived] = useState(false)

  const visible = useMemo(() => {
    return items.filter((p) => {
      if (p.archived) return isEditor && showArchived
      if (filter === 'active') return p.status !== 'finished'
      if (filter === 'attention') return p.needsAttention
      return true // all
    })
  }, [items, filter, showArchived, isEditor])

  // Group by category in lookup order; unknown/none last.
  const groups = useMemo(() => {
    const categoryOrder = lookups.category ?? []
    const byKey = new Map<string, PlanListItem[]>()
    for (const p of visible) {
      const key = p.category ?? '__none__'
      ;(byKey.get(key) ?? byKey.set(key, []).get(key)!).push(p)
    }
    const ordered: { key: string; label: string; plans: PlanListItem[] }[] = []
    for (const c of categoryOrder) {
      if (byKey.has(c.key)) {
        ordered.push({ key: c.key, label: c.label, plans: byKey.get(c.key)! })
        byKey.delete(c.key)
      }
    }
    // Any categories not in the lookup, then "No category".
    for (const [key, plans] of Array.from(byKey.entries())) {
      if (key === '__none__') continue
      ordered.push({ key, label: key, plans })
    }
    if (byKey.has('__none__')) ordered.push({ key: '__none__', label: 'No category', plans: byKey.get('__none__')! })
    return ordered
  }, [visible, lookups])

  return (
    <div className="space-y-4">
      {/* Header + actions. Omitted when the page renders TrackerHeader (design
          spec: group name → page title + buttons → tabs). */}
      {!hideHeader && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <FolderKanban className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold">Projects</h1>
          </div>
          <div className="flex-1" />
          {isEditor && (
            <div className="flex items-center gap-2">
              <Button asChild size="sm">
                <Link href="/tracker/plans/new">New project</Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/tracker/plans/import">Import</Link>
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-md border p-0.5" role="tablist" aria-label="Filter projects">
          {(['active', 'attention', 'all'] as Filter[]).map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded px-3 py-1 text-sm font-medium transition-colors',
                filter === f ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {f === 'active' ? 'Active' : f === 'attention' ? 'Needs attention' : 'All'}
            </button>
          ))}
        </div>
        {isEditor && (
          <div className="min-w-[160px]">
            <ToggleSwitch
              checked={showArchived}
              onCheckedChange={setShowArchived}
              label="Show archived"
            />
          </div>
        )}
        <span className="text-sm text-muted-foreground">
          {visible.length} project{visible.length === 1 ? '' : 's'}
        </span>
      </div>

      {visible.length === 0 ? (
        <div className="space-y-1">
          {!isEditor && items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              You haven&apos;t been added to any projects yet. A Manager can add you as Lead or
              Member, or give you access.
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">No projects to show.</p>
              {isEditor && (
                <p className="text-sm text-muted-foreground">
                  Create one, or import from the previous tracker.
                </p>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.key} aria-label={g.label} className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {g.label} · {g.plans.length} project{g.plans.length === 1 ? '' : 's'}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {g.plans.map((p) => (
                  <PlanCard key={p.id} plan={p} lookups={lookups} today={today} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function PlanCard({ plan, lookups, today }: { plan: PlanListItem; lookups: Lookups; today: string }) {
  const statusLabel = lookupLabel(lookups, 'status', plan.status)
  const regionLabel = lookupLabel(lookups, 'region', plan.region)
  const phaseLabel = plan.phase ?? ''

  // Warnings shown in red (design spec): overdue action, no next action, no
  // update for a while. The status itself is shown via the coloured status
  // label above, so it is not repeated as a warning here.
  const warnings: string[] = []
  if (plan.flagOverdueAction) warnings.push('Overdue action')
  if (plan.flagNoOpenAction) warnings.push('No next action')
  if (plan.flagStale && plan.lastUpdated) {
    warnings.push(`No update for ${daysBetweenISO(plan.lastUpdated, today)} days`)
  }

  const pct = plan.nextMilestonePct ?? 0

  return (
    // The whole card opens the project: the title is a real link (so keyboard
    // users can focus it and screen readers read it as a link to the project),
    // and its ::after overlay stretches across the relatively-positioned card so
    // a tap or click anywhere opens it too. No other interactive controls sit on
    // the card, so the overlay is safe.
    <div
      className={cn(
        'relative flex h-full flex-col gap-2 rounded-xl border bg-card p-4 text-card-foreground shadow-sm transition-colors hover:border-primary/50 focus-within:ring-2 focus-within:ring-ring',
        plan.archived && 'opacity-60',
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <StatusLabel statusKey={plan.status} label={statusLabel} />
        {regionLabel && <span>{regionLabel}</span>}
        {phaseLabel && <span>· {phaseLabel}</span>}
        {plan.archived && <Badge variant="outline">Archived</Badge>}
      </div>

      <Link
        href={`/tracker/plans/${plan.id}`}
        className="text-base font-semibold leading-snug outline-none after:absolute after:inset-0 after:rounded-xl hover:underline"
      >
        {plan.name}
      </Link>

      {plan.client && <p className="text-sm text-muted-foreground">{plan.client}</p>}

      {plan.subPlans > 0 && (
        <p className="text-xs text-muted-foreground">
          {plan.subPlans} sub-project{plan.subPlans === 1 ? '' : 's'}
        </p>
      )}

      <div className="mt-1 space-y-1 text-sm">
        <div>
          <span className="text-muted-foreground">Next action: </span>
          {plan.nextActionTitle ? (
            <span>
              {plan.nextActionTitle}
              {plan.nextActionDue && (
                <span className="text-muted-foreground"> · due {formatDate(plan.nextActionDue)}</span>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>

        {plan.nextMilestoneTitle ? (
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate">
                <span className="text-muted-foreground">Milestone: </span>
                {plan.nextMilestoneTitle}
              </span>
              {!(plan.nextMilestoneFromActions && (plan.nextMilestoneTotal ?? 0) === 0) && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {plan.nextMilestoneDone} of {plan.nextMilestoneTotal} · {pct}%
                </span>
              )}
            </div>
            {/* A "from its actions" milestone with nothing linked has no bar — it
                would read "0 of 0 · 0%". Say so plainly instead. */}
            {plan.nextMilestoneFromActions && (plan.nextMilestoneTotal ?? 0) === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">No actions linked yet</p>
            ) : (
              <Progress value={pct} className="mt-1" />
            )}
          </div>
        ) : (
          // No upcoming milestone: fall back to the project's own progress.
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Progress</span>
              <span className="shrink-0 text-xs text-muted-foreground">{plan.planProgressPct}%</span>
            </div>
            <Progress value={plan.planProgressPct} className="mt-1" />
          </div>
        )}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-xs text-muted-foreground">
        <span>{plan.openActions} open action{plan.openActions === 1 ? '' : 's'}</span>
        {plan.lastUpdated && <span>Updated {formatDate(plan.lastUpdated)}</span>}
      </div>

      {warnings.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {warnings.map((text, i) => (
            <Badge key={i} variant="error">
              {text}
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}
