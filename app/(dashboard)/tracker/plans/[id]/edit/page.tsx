import { notFound, redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import { getTrackerContext, isEditor, canAccess, getGroupPeople, getTrackerHeaderData } from '@/lib/tracker/server'
import Link from 'next/link'
import { buildLookups, lookupLabel, optionsWithCurrent, type LookupRow } from '@/lib/tracker/view'
import TrackerHeader from '@/components/tracker/TrackerHeader'
import PlanForm, { type PlanFormValues } from '@/components/tracker/PlanForm'

export const dynamic = 'force-dynamic'

const MANAGER_ROLES = ['manager', 'group_owner']

export default async function EditPlanPage({ params }: { params: { id: string } }) {
  noStore()
  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')
  const { supabase, groupId } = ctx
  const planId = params.id

  const { data: plan } = await supabase
    .from('tracker_project_plans')
    .select('*')
    .eq('id', planId)
    .maybeSingle()
  if (!plan) notFound()

  const [editor, canEdit] = await Promise.all([
    isEditor(supabase, groupId),
    canAccess(supabase, planId, 'edit'),
  ])
  if (!canEdit) redirect(`/tracker/plans/${planId}`)

  // The remaining reads don't depend on each other, so run them at the same
  // time (Promise.all) rather than one after another.
  const [header, { data: lookupRows }, { data: allPlans }, people, { data: memberRows }] = await Promise.all([
    getTrackerHeaderData(ctx),
    // Load BOTH shown and hidden lookup values (existing records keep labels);
    // the form's dropdowns use activeOptions() to show only the shown ones.
    supabase
      .from('tracker_lookups')
      .select('list, key, label, colour, sort_order, active')
      .eq('group_id', groupId),
    // Candidate parents = same group, not itself and not one of its own
    // sub-projects (the DB also rejects self-parenting; this keeps the picker
    // sensible — descendants are excluded).
    supabase
      .from('tracker_project_plans')
      .select('id, name, parent_id')
      .eq('group_id', groupId)
      .is('archived_at', null),
    getGroupPeople(supabase, groupId).then((p) => p ?? []),
    // Current members (role = 'member'); the lead stays in lead_id.
    supabase
      .from('tracker_plan_members')
      .select('user_id, role')
      .eq('plan_id', planId)
      .eq('role', 'member'),
  ])

  const lookups = buildLookups((lookupRows ?? []) as LookupRow[])

  const descendants = collectDescendants(planId, (allPlans ?? []) as { id: string; parent_id: string | null }[])
  const parentOptions = (allPlans ?? [])
    .filter((p) => p.id !== planId && !descendants.has(p.id as string))
    .map((p) => ({ id: p.id as string, name: p.name as string }))

  const peopleOptions = people.map((p) => ({ id: p.id, name: p.name || '—' }))
  const managers = people
    .filter((p) => MANAGER_ROLES.includes(p.role))
    .map((p) => ({ id: p.id, name: p.name || '—' }))

  const memberIds = (memberRows ?? []).map((m) => m.user_id as string)

  const initial: PlanFormValues = {
    name: (plan.name as string) ?? '',
    category: (plan.category as string | null) ?? '',
    status: (plan.status as string | null) ?? '',
    client: (plan.client as string | null) ?? '',
    phase: (plan.phase as string | null) ?? '',
    summary: (plan.summary as string | null) ?? '',
    folder: (plan.folder as string | null) ?? '',
    parent_id: (plan.parent_id as string | null) ?? '',
    region: (plan.region as string | null) ?? '',
    start_on: (plan.start_on as string | null) ?? '',
    end_on: (plan.end_on as string | null) ?? '',
    priority: (plan.priority as string | null) ?? 'normal',
    progress_pct: (plan.progress_pct as number | null) ?? 0,
    owner_id: (plan.owner_id as string | null) ?? '',
    lead_id: (plan.lead_id as string | null) ?? '',
    member_ids: memberIds,
  }

  const categoryLabel = lookupLabel(lookups, 'category', plan.category as string | null)

  return (
    <div className="space-y-4">
      <TrackerHeader groupName={header.groupName} title={`Edit ${plan.name as string}`} showSettings={header.showSettings} />
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Link href="/tracker/plans" className="hover:underline">Projects</Link>
          <span>›</span>
          {categoryLabel && (
            <>
              <span>{categoryLabel}</span>
              <span>›</span>
            </>
          )}
          <span className="truncate">{plan.name as string}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Managers and Group Owners create projects. Editing an existing project uses the same form.
        </p>
      </div>
      <PlanForm
        mode="edit"
        planId={planId}
        initial={initial}
        categories={optionsWithCurrent(lookups, 'category', plan.category as string | null)}
        statuses={optionsWithCurrent(lookups, 'status', plan.status as string | null)}
        regions={optionsWithCurrent(lookups, 'region', plan.region as string | null)}
        priorities={[{ key: 'normal', label: 'Normal' }, { key: 'high', label: 'High' }]}
        parentOptions={parentOptions}
        people={peopleOptions}
        managers={managers}
        isEditor={editor}
        canEditMembers={editor}
      />
    </div>
  )
}

/** All plan ids that have `rootId` somewhere up their parent chain. */
function collectDescendants(rootId: string, plans: { id: string; parent_id: string | null }[]): Set<string> {
  const childrenOf = new Map<string, string[]>()
  for (const p of plans) {
    if (p.parent_id) (childrenOf.get(p.parent_id) ?? childrenOf.set(p.parent_id, []).get(p.parent_id)!).push(p.id)
  }
  const out = new Set<string>()
  const stack = [...(childrenOf.get(rootId) ?? [])]
  while (stack.length) {
    const id = stack.pop()!
    if (out.has(id)) continue
    out.add(id)
    stack.push(...(childrenOf.get(id) ?? []))
  }
  return out
}
