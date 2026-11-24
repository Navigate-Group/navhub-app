import Link from 'next/link'
import { redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import { getTrackerContext, ensureGroupSetup, isEditor, getTrackerHeaderData } from '@/lib/tracker/server'
import { buildLookups, type LookupRow, type AttentionRow, type MilestoneProgressRow } from '@/lib/tracker/view'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import TrackerHeader from '@/components/tracker/TrackerHeader'
import PlansList from '@/components/tracker/PlansList'
import type { PlanListItem } from '@/components/tracker/PlansList'

export const dynamic = 'force-dynamic'

export default async function PlansPage() {
  noStore()

  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')
  const { supabase, groupId } = ctx

  // Brief item 3: set the group up if needed (editor bootstraps; others see a
  // "not set up yet" message).
  const setup = await ensureGroupSetup(ctx)
  if (setup.state === 'not_set_up') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Projects</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Projects aren&apos;t set up for this group yet. Ask a Manager to open Projects first.
          </p>
        </CardContent>
      </Card>
    )
  }
  if (setup.state === 'error') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Projects</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">Couldn&apos;t open Projects: {setup.message}</p>
        </CardContent>
      </Card>
    )
  }

  // These reads don't depend on each other, so run them all at the same time
  // (Promise.all) rather than one after another — this is what makes the list
  // open quickly.
  const [
    editor,
    header,
    { data: lookupRows },
    { data: planRows },
    { data: attentionRows },
    { data: milestoneRows },
    { data: milestoneTitles },
    { data: todayVal },
  ] = await Promise.all([
    isEditor(supabase, groupId),
    getTrackerHeaderData(ctx),
    // Lookups for labels and category order.
    supabase
      .from('tracker_lookups')
      .select('list, key, label, colour, sort_order')
      .eq('group_id', groupId)
      .eq('active', true),
    // Plans (RLS-scoped to the group). Load all; filter client-side.
    supabase
      .from('tracker_project_plans')
      .select('id, name, client, phase, region, category, parent_id, status, sort_order, archived_at')
      .eq('group_id', groupId)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true }),
    // Attention view (next action, last updated, flags, counts).
    supabase
      .from('tracker_v_plan_attention')
      .select(
        'plan_id, is_active, status, last_updated, open_actions, sub_plans, next_action_id, next_action_title, next_action_due, flag_status, flag_no_open_action, flag_overdue_action, flag_stale, needs_attention',
      )
      .eq('group_id', groupId),
    // Earliest not-completed/cancelled milestone per plan (next milestone).
    supabase
      .from('tracker_v_milestone_progress')
      .select('milestone_id, plan_id, status, due_on, done_actions, total_actions, progress_pct, days_slipped, overdue')
      .eq('group_id', groupId),
    // Milestone titles (the progress view has no title).
    supabase
      .from('tracker_milestones')
      .select('id, title')
      .eq('group_id', groupId)
      .is('archived_at', null),
    // Today (group time zone) via the DB helper, so labels match the views.
    supabase.rpc('tracker_today', { p_group_id: groupId }),
  ])

  const lookups = buildLookups((lookupRows ?? []) as LookupRow[])

  const titleById = new Map<string, string>()
  for (const m of milestoneTitles ?? []) titleById.set(m.id as string, (m.title as string) ?? '')

  const today = typeof todayVal === 'string' ? todayVal : new Date().toISOString().slice(0, 10)

  const attentionByPlan = new Map<string, AttentionRow>()
  for (const a of (attentionRows ?? []) as unknown as AttentionRow[]) attentionByPlan.set(a.plan_id, a)

  // Next milestone = earliest due, not completed/cancelled.
  const nextMilestoneByPlan = new Map<string, MilestoneProgressRow>()
  for (const m of (milestoneRows ?? []) as unknown as MilestoneProgressRow[]) {
    if (m.status === 'completed' || m.status === 'cancelled') continue
    const existing = nextMilestoneByPlan.get(m.plan_id)
    const mDue = m.due_on ?? '9999-12-31'
    const eDue = existing ? (existing.due_on ?? '9999-12-31') : null
    if (!existing || (eDue !== null && mDue < eDue)) nextMilestoneByPlan.set(m.plan_id, m)
  }

  const items: PlanListItem[] = (planRows ?? [])
    .filter((p) => p.parent_id === null) // top-level only; sub-projects counted on the parent
    .map((p) => {
      const a = attentionByPlan.get(p.id as string)
      const nm = nextMilestoneByPlan.get(p.id as string)
      return {
        id: p.id as string,
        name: p.name as string,
        client: (p.client as string | null) ?? null,
        phase: (p.phase as string | null) ?? null,
        region: (p.region as string | null) ?? null,
        category: (p.category as string | null) ?? null,
        status: (p.status as string | null) ?? null,
        archived: p.archived_at !== null,
        isActive: a?.is_active ?? (p.status !== 'finished'),
        lastUpdated: (a?.last_updated as string | null) ?? null,
        openActions: a?.open_actions ?? 0,
        subPlans: a?.sub_plans ?? 0,
        needsAttention: a?.needs_attention ?? false,
        nextActionTitle: (a?.next_action_title as string | null) ?? null,
        nextActionDue: (a?.next_action_due as string | null) ?? null,
        flagStatus: a?.flag_status ?? false,
        flagNoOpenAction: a?.flag_no_open_action ?? false,
        flagOverdueAction: a?.flag_overdue_action ?? false,
        flagStale: a?.flag_stale ?? false,
        nextMilestoneTitle: nm ? (titleById.get(nm.milestone_id) ?? '') : null,
        nextMilestoneDone: nm ? nm.done_actions : null,
        nextMilestoneTotal: nm ? nm.total_actions : null,
        nextMilestonePct: nm ? nm.progress_pct : null,
      }
    })

  return (
    <>
      {/* Group name → page title + buttons → tabs (design spec) */}
      <TrackerHeader
        groupName={header.groupName}
        title="Projects"
        showSettings={header.showSettings}
        actions={
          editor ? (
            <>
              <Button asChild size="sm">
                <Link href="/tracker/plans/new">New project</Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/tracker/plans/import">Import</Link>
              </Button>
            </>
          ) : undefined
        }
      />
      <PlansList
        items={items}
        lookups={lookups}
        today={today}
        isEditor={editor}
        hideHeader
      />
    </>
  )
}
