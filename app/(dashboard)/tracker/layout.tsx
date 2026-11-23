import { redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import { getTrackerContext } from '@/lib/tracker/server'

/**
 * Shared tracker shell (P5/P6). The group name, page title and section tabs are
 * rendered per-page by TrackerHeader, in the agreed order (group name → page
 * title + buttons → tabs), so the tabs sit below the page title. This layout
 * just provides the centred column and guards the session.
 */
export default async function TrackerLayout({ children }: { children: React.ReactNode }) {
  noStore()

  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')

  return <div className="mx-auto max-w-6xl">{children}</div>
}
