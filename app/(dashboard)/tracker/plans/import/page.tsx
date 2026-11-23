import Link from 'next/link'
import { redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import { getTrackerContext, isEditor } from '@/lib/tracker/server'
import { buildLookups, type LookupRow } from '@/lib/tracker/view'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import ImportWizard from '@/components/tracker/ImportWizard'

export const dynamic = 'force-dynamic'

// /tracker/plans/import — import projects from the previous tracker (P4).
// Managers and Group Owners only; the database refuses anyone else anyway.
export default async function ImportPage() {
  noStore()
  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')
  const { supabase, groupId } = ctx

  if (!(await isEditor(supabase, groupId))) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Import projects</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Only a Manager or Group Owner can import projects.{' '}
            <Link href="/tracker/plans" className="text-primary underline-offset-4 hover:underline">
              Back to Projects
            </Link>
          </p>
        </CardContent>
      </Card>
    )
  }

  const { data: lookupRows } = await supabase
    .from('tracker_lookups')
    .select('list, key, label, colour, sort_order')
    .eq('group_id', groupId)
  const lookups = buildLookups((lookupRows ?? []) as LookupRow[])
  const labels: Record<string, string> = {}
  for (const list of ['category', 'status']) {
    for (const o of lookups[list] ?? []) labels[`${list}:${o.key}`] = o.label
  }

  return (
    <div className="space-y-4">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <Link href="/tracker/plans" className="hover:text-foreground">Projects</Link>
        <span aria-hidden="true"> › </span>
        <span>Import</span>
      </nav>
      <div>
        <h1 className="text-xl font-semibold">Import projects</h1>
        <p className="text-sm text-muted-foreground">
          Bring in projects from the previous tracker&apos;s export file, with their milestones, actions,
          contacts, updates and handover notes. You see a preview before anything is saved.
        </p>
      </div>
      <ImportWizard labels={labels} />
    </div>
  )
}
