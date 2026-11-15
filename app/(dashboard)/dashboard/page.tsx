import { redirect } from 'next/navigation'

// The dashboard has been superseded by the welcoming home page (/home).
// The original dashboard implementation is preserved at
// app/(dashboard)/dashboard/_legacy/DashboardPage.tsx for reference.
// Every request to /dashboard now redirects to /home.
export default function DashboardPage() {
  redirect('/home')
}
