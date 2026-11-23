import Link from 'next/link'
import { redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import { getTrackerContext, isEditor, getTrackerHeaderData } from '@/lib/tracker/server'
import { buildLookups, type LookupRow } from '@/lib/tracker/view'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import TrackerHeader from '@/components/tracker/TrackerHeader'
import ImportWizard, { type LookupOption } from '@/components/tracker/ImportWizard'

export const dynamic = 'force-dynamic'

export default async function ImportPlansPage() {
  noStore()

  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')
  const { supabase, groupId } = ctx

  const [editor, header] = await Promise.all([
    isEditor(supabase, groupId),
    getTrackerHeaderData(ctx),
  ])

  const trackerHeader = (
    <TrackerHeader groupName={header.groupName} title="Import projects" showSettings={header.showSettings} />
  )

  const breadcrumb = (
    <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
      <Link href="/tracker/plans" className="hover:underline">
        Projects
      </Link>
      <span aria-hidden="true"> › </span>
      <span className="text-foreground">Import</span>
    </nav>
  )

  if (!editor) {
    return (
      <div className="space-y-4">
        {trackerHeader}
        {breadcrumb}
        <Card>
          <CardHeader>
            <CardTitle>Import projects</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Only a Manager or Group Owner can import projects.
            </p>
            <p className="text-sm">
              <Link href="/tracker/plans" className="text-primary hover:underline">
                Back to Projects
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Labels for the preview's category/status keys.
  const { data: lookupRows } = await supabase
    .from('tracker_lookups')
    .select('list, key, label, colour, sort_order')
    .eq('group_id', groupId)
    .eq('active', true)
  const lookups = buildLookups((lookupRows ?? []) as LookupRow[])

  const categoryLabels: LookupOption[] = (lookups.category ?? []).map((o) => ({ key: o.key, label: o.label }))
  const statusLabels: LookupOption[] = (lookups.status ?? []).map((o) => ({ key: o.key, label: o.label }))

  return (
    <div className="space-y-4">
      {trackerHeader}
      {breadcrumb}
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">
          Choose an export file from the previous tracker. You&apos;ll see a preview before anything is
          saved.
        </p>
      </div>
      <ImportWizard categoryLabels={categoryLabels} statusLabels={statusLabels} />
    </div>
  )
}
