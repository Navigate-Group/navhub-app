import { redirect } from 'next/navigation'

// /tracker redirects to the Projects list for now (P5).
export default function TrackerIndexPage() {
  redirect('/tracker/plans')
}
