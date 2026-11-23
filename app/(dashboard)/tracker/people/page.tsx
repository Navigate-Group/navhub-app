import { redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import { getTrackerContext, getTrackerHeaderData } from '@/lib/tracker/server'
import TrackerHeader from '@/components/tracker/TrackerHeader'
import ComingSoon from '@/components/tracker/ComingSoon'

export default async function PeoplePage() {
  noStore()
  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')
  const header = await getTrackerHeaderData(ctx)
  return (
    <>
      <TrackerHeader groupName={header.groupName} title="People" showSettings={header.showSettings} />
      <ComingSoon
        title="People"
        description="The group's contacts, and who works on what, arrive in a later release."
      />
    </>
  )
}
