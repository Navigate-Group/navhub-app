import { redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import { getTrackerContext, isEditor } from '@/lib/tracker/server'
import TrackerTabs from '@/components/tracker/TrackerTabs'

/**
 * Shared tracker shell (P5). Renders the section tabs on every /tracker page.
 * Settings is Manager / Group Owner only. Group setup (tracker_init_group) is
 * handled by the Projects page itself (brief item 3).
 */
export default async function TrackerLayout({ children }: { children: React.ReactNode }) {
  noStore()

  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')

  const editor = await isEditor(ctx.supabase, ctx.groupId)

  return (
    <div className="mx-auto max-w-6xl">
      <TrackerTabs showSettings={editor} />
      {children}
    </div>
  )
}
