import { redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import { getTrackerContext, getTrackerHeaderData } from '@/lib/tracker/server'
import TrackerHeader from '@/components/tracker/TrackerHeader'
import ComingSoon from '@/components/tracker/ComingSoon'

export default async function WeeklyReviewPage() {
  noStore()
  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')
  const header = await getTrackerHeaderData(ctx)
  return (
    <>
      <TrackerHeader groupName={header.groupName} title="Weekly review" showSettings={header.showSettings} />
      <ComingSoon
        title="Weekly review"
        description="The guided weekly review and its health checks arrive in a later release."
      />
    </>
  )
}
