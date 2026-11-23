import { redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import { getTrackerContext, isEditor, getTrackerHeaderData } from '@/lib/tracker/server'
import TrackerHeader from '@/components/tracker/TrackerHeader'
import ComingSoon from '@/components/tracker/ComingSoon'

// Settings is Managers / Group Owners only (P8 builds the real page).
export default async function TrackerSettingsPage() {
  noStore()
  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')
  if (!(await isEditor(ctx.supabase, ctx.groupId))) redirect('/tracker/plans')
  const header = await getTrackerHeaderData(ctx)
  return (
    <>
      <TrackerHeader groupName={header.groupName} title="Settings" showSettings={header.showSettings} />
      <ComingSoon
        title="Settings"
        description="The tracker's lists, reminder days and time zone arrive in a later release."
      />
    </>
  )
}
