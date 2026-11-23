import Link from 'next/link'
import { redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import { getTrackerContext, isEditor } from '@/lib/tracker/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import ImportWizard from '@/components/tracker/ImportWizard'

export const dynamic = 'force-dynamic'

/**
 * Import the previous tracker's export (P4). Breadcrumb Projects › Import.
 * Managers / Group Owners only — a non-editor sees a message (the preview and
 * apply APIs refuse non-editors too, and the database is the final guard).
 */
export default async function ImportPage() {
  noStore()
  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')
  const { supabase, groupId } = ctx

  const editor = await isEditor(supabase, groupId)

  return (
    <div className="space-y-4">
      <nav className="text-sm text-muted-foreground" aria-label="Breadcrumb">
        <Link href="/tracker/plans" className="hover:underline">
          Projects
        </Link>
        <span aria-hidden="true"> › </span>
        <span className="text-foreground">Import</span>
      </nav>

      <Card>
        <CardHeader>
          <CardTitle>Import from the previous tracker</CardTitle>
        </CardHeader>
        <CardContent>
          {editor ? (
            <ImportWizard />
          ) : (
            <p className="text-sm text-muted-foreground">
              Only a Manager or Group Owner can import projects. Ask one of them to run the import.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
