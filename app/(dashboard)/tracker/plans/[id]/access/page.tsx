import { notFound, redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import Link from 'next/link'
import { getTrackerContext, isEditor, getGroupPeople, getTrackerHeaderData } from '@/lib/tracker/server'
import TrackerHeader from '@/components/tracker/TrackerHeader'
import ManageAccess, { type AccessPerson, type PickablePerson } from '@/components/tracker/ManageAccess'

export const dynamic = 'force-dynamic'

const EDITOR_ROLES = ['manager', 'group_owner']

export default async function ProjectAccessPage({ params }: { params: { id: string } }) {
  noStore()
  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')
  const { supabase, groupId } = ctx
  const planId = params.id

  const { data: plan } = await supabase
    .from('tracker_project_plans')
    .select('id, name, group_id')
    .eq('id', planId)
    .maybeSingle()
  if (!plan) notFound()

  const [editor, header] = await Promise.all([
    isEditor(supabase, groupId),
    getTrackerHeaderData(ctx),
  ])
  // Only Managers / Group Owners manage access. Others are sent back to the
  // project (the database would refuse writes anyway).
  if (!editor) redirect(`/tracker/plans/${planId}`)

  const { data: group } = await supabase.from('groups').select('name').eq('id', groupId).maybeSingle()
  const groupName = (group?.name as string | null) ?? 'this group'

  // Count sub-projects (direct children) to word the note.
  const { count: subCount } = await supabase
    .from('tracker_project_plans')
    .select('id', { count: 'exact', head: true })
    .eq('group_id', groupId)
    .eq('parent_id', planId)

  // People of the group, and existing shares on this plan.
  const [people, { data: shares }] = await Promise.all([
    getGroupPeople(supabase, groupId),
    supabase.from('tracker_plan_shares').select('user_id, level').eq('plan_id', planId),
  ])
  const allPeople = people ?? []

  const shareByUser = new Map<string, 'comment' | 'edit'>()
  for (const s of shares ?? []) {
    const lvl = s.level as string
    shareByUser.set(s.user_id as string, lvl === 'edit' ? 'edit' : 'comment')
  }

  // Non-editor members are pickable (editors already have full access).
  const pickable: PickablePerson[] = allPeople
    .filter((p) => !EDITOR_ROLES.includes(p.role))
    .map((p) => ({ id: p.id, name: p.name || '—', role: p.role }))

  const withAccess: AccessPerson[] = allPeople
    .filter((p) => shareByUser.has(p.id) && !EDITOR_ROLES.includes(p.role))
    .map((p) => ({ id: p.id, name: p.name || '—', role: p.role, level: shareByUser.get(p.id)! }))

  const fullAccess = allPeople.filter((p) => EDITOR_ROLES.includes(p.role))

  return (
    <div className="space-y-4">
      <TrackerHeader groupName={header.groupName} title="Project access" showSettings={header.showSettings} />

      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Link href="/tracker/plans" className="hover:underline">Projects</Link>
        <span>›</span>
        <Link href={`/tracker/plans/${planId}`} className="hover:underline truncate">{plan.name as string}</Link>
        <span>›</span>
        <span>Project access</span>
      </div>

      <div className="space-y-2 rounded-lg border bg-muted/40 p-3 text-sm">
        <p>
          Everyone in {groupName} can already read this project. Give a member Comment or Edit to let
          them work on it.
        </p>
        {(subCount ?? 0) > 0 && (
          <p className="text-muted-foreground">
            Access here also covers its {subCount} sub-project{subCount === 1 ? '' : 's'}.
          </p>
        )}
      </div>

      <ManageAccess planId={planId} pickable={pickable} withAccess={withAccess} />

      <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
        <h2 className="mb-2 text-sm font-semibold">Full access (from their role)</h2>
        {fullAccess.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Managers or Group Owners in this group.</p>
        ) : (
          <p className="text-sm">
            {fullAccess.map((p) => p.name || '—').join(', ')}
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Given by a Manager or Group Owner. Removing someone from the group removes their access
          straight away.
        </p>
      </section>
    </div>
  )
}
