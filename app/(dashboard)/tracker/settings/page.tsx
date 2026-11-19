import { redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import { getTrackerContext, isEditor } from '@/lib/tracker/server'
import ComingSoon from '@/components/tracker/ComingSoon'

// Settings is Managers / Group Owners only (P8 builds the real page).
export default async function TrackerSettingsPage() {
  noStore()
  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')
  if (!(await isEditor(ctx.supabase, ctx.groupId))) redirect('/tracker/plans')
  return <ComingSoon title="Settings" />
}
