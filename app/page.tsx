import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import MarketingHomepage from '@/components/marketing/MarketingHomepage'

export default async function RootPage() {
  const headersList = headers()
  const hostname = headersList.get('host') ?? ''
  const isMarketingSite = hostname.startsWith('www.') || hostname === 'navhub.co'

  if (isMarketingSite) {
    return <MarketingHomepage />
  }

  // App subdomain — redirect based on auth
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()

  if (session) {
    redirect('/home')
  } else {
    redirect('/login')
  }
}
