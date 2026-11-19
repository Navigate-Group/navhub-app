import { redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import { getTrackerContext, isEditor, getGroupPeople } from '@/lib/tracker/server'
import { buildLookups, type LookupRow } from '@/lib/tracker/view'
import PlanForm, { type PlanFormValues } from '@/components/tracker/PlanForm'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export const dynamic = 'force-dynamic'

const MANAGER_ROLES = ['manager', 'group_owner']

export default async function NewPlanPage() {
  noStore()
  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')
  const { supabase, userId, groupId } = ctx

  const editor = await isEditor(supabase, groupId)
  if (!editor) redirect('/tracker/plans')

  const { data: lookupRows } = await supabase
    .from('tracker_lookups')
    .select('list, key, label, colour, sort_order')
    .eq('group_id', groupId)
    .eq('active', true)
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
    <Card>
      <CardHeader>
        <CardTitle>New project</CardTitle>
      </CardHeader>
      <CardContent>
        <PlanForm
          mode="new"
          initial={initial}
          categories={(lookups.category ?? []).map((o) => ({ key: o.key, label: o.label }))}
          statuses={(lookups.status ?? []).map((o) => ({ key: o.key, label: o.label }))}
          regions={(lookups.region ?? []).map((o) => ({ key: o.key, label: o.label }))}
          priorities={[{ key: 'normal', label: 'Normal' }, { key: 'high', label: 'High' }]}
          parentOptions={(planRows ?? []).map((p) => ({ id: p.id as string, name: p.name as string }))}
          people={peopleOptions}
          managers={managers}
          isEditor={editor}
          canEditMembers={editor}
        />
      </CardContent>
    </Card>
  )
}
