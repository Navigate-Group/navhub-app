import { redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import { getTrackerContext, isEditor, getGroupPeople, getTrackerHeaderData } from '@/lib/tracker/server'
import { buildLookups, activeOptions, type LookupRow } from '@/lib/tracker/view'
import Link from 'next/link'
import TrackerHeader from '@/components/tracker/TrackerHeader'
import PlanForm, { type PlanFormValues } from '@/components/tracker/PlanForm'

export const dynamic = 'force-dynamic'

const MANAGER_ROLES = ['manager', 'group_owner']

export default async function NewPlanPage() {
  noStore()
  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')
  const { supabase, userId, groupId } = ctx

  const editor = await isEditor(supabase, groupId)
  if (!editor) redirect('/tracker/plans')
  const header = await getTrackerHeaderData(ctx)

  // Load BOTH shown and hidden lookup values (existing records keep labels);
  // the form's dropdowns use activeOptions() to show only the shown ones.
  const { data: lookupRows } = await supabase
    .from('tracker_lookups')
    .select('list, key, label, colour, sort_order, active')
    .eq('group_id', groupId)
  const lookups = buildLookups((lookupRows ?? []) as LookupRow[])

  const { data: planRows } = await supabase
    .from('tracker_project_plans')
    .select('id, name')
    .eq('group_id', groupId)
    .is('archived_at', null)
    .order('name', { ascending: true })

  const people = (await getGroupPeople(supabase, groupId)) ?? []
  const peopleOptions = people.map((p) => ({ id: p.id, name: p.name || '—' }))
  const managers = people
    .filter((p) => MANAGER_ROLES.includes(p.role))
    .map((p) => ({ id: p.id, name: p.name || '—' }))

  const initial: PlanFormValues = {
    name: '',
    category: '',
    status: '',
    client: '',
    phase: '',
    summary: '',
    folder: '',
    parent_id: '',
    region: '',
    start_on: '',
    end_on: '',
    priority: 'normal',
    progress_pct: 0,
    owner_id: userId, // default the creator
    lead_id: '',
    member_ids: [],
  }

  return (
    <div className="space-y-4">
      <TrackerHeader groupName={header.groupName} title="New project" showSettings={header.showSettings} />
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link href="/tracker/plans" className="hover:underline">Projects</Link>
          <span>›</span>
          <span>New project</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Managers and Group Owners create projects. Editing an existing project uses the same form.
        </p>
      </div>
      <PlanForm
        mode="new"
        initial={initial}
        categories={activeOptions(lookups, 'category')}
        statuses={activeOptions(lookups, 'status')}
        regions={activeOptions(lookups, 'region')}
        priorities={[{ key: 'normal', label: 'Normal' }, { key: 'high', label: 'High' }]}
        parentOptions={(planRows ?? []).map((p) => ({ id: p.id as string, name: p.name as string }))}
        people={peopleOptions}
        managers={managers}
        isEditor={editor}
        canEditMembers={editor}
      />
    </div>
  )
}
