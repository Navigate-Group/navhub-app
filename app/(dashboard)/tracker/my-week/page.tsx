import { redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import { getTrackerContext, getTrackerHeaderData } from '@/lib/tracker/server'
import TrackerHeader from '@/components/tracker/TrackerHeader'
import ComingSoon from '@/components/tracker/ComingSoon'

export default async function MyWeekPage() {
  noStore()
  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')
  const header = await getTrackerHeaderData(ctx)
  return (
    <>
      <TrackerHeader groupName={header.groupName} title="My week" showSettings={header.showSettings} />
      <ComingSoon
        title="My week"
        description="Your actions grouped by due date, with the summary tiles, arrive in a later release."
      />
    </>
  )
}
