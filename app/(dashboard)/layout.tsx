import { cookies }                from 'next/headers'
import { redirect }               from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import { createClient }           from '@/lib/supabase/server'
import { createAdminClient }      from '@/lib/supabase/admin'
import AppShell                   from '@/components/layout/AppShell'
import ImpersonationBanner        from '@/components/admin/ImpersonationBanner'
import { getPalette, buildPaletteCSS } from '@/lib/themes'
import { decrypt }                from '@/lib/encryption'
import { getUserPermissions, getVisibleFeatures } from '@/lib/permissions'
import { getMarketsAccess, canViewMarkets } from '@/lib/markets'
import type { Group, UserGroup, AppRole, FeatureKey } from '@/lib/types'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Opt out of Next.js Data Cache so palette_id (and all group data) is always
  // fetched fresh from the DB — prevents stale palette on hard refresh.
  noStore()

  const supabase = createClient()

  // Auth check
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session) redirect('/login')

  // Load all groups the user belongs to, with group details
  const { data: userGroups } = await supabase
    .from('user_groups')
    .select('*, group:groups(*)')
    .eq('user_id', session.user.id)
    .order('is_default', { ascending: false })

  if (!userGroups || userGroups.length === 0) {
    // Logged in but no group memberships — redirect to landing page
    redirect('/landing')
  }

  // Determine active group from cookie
  const cookieStore = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const activeUserGroup =
    userGroups.find((ug) => ug.group_id === activeGroupId) ??
    userGroups.find((ug) => ug.is_default) ??
    userGroups[0]

  // If the cookie was missing or pointed to a group we don't belong to, repair it
  if (activeGroupId !== activeUserGroup.group_id) {
    try {
      cookieStore.set('active_group_id', activeUserGroup.group_id, {
        httpOnly: false,
        path:     '/',
        maxAge:   60 * 60 * 24 * 365,
      })
    } catch {
      // Can't set cookies in all rendering contexts — silently continue
    }
  }

  let activeGroup = activeUserGroup.group as Group

  // Cast userGroups to typed array (group is always present due to join)
  const typedGroups = userGroups as (UserGroup & { group: Group })[]

  // ── Impersonation check ────────────────────────────────────────────────────
  // If the navhub_impersonate_group cookie is set, we're in impersonation mode.
  // Override activeGroup with the impersonated group's metadata.
  let impersonatedGroupName: string | null = null

  const impersonateCookieValue = cookieStore.get('navhub_impersonate_group')?.value
  if (impersonateCookieValue) {
    try {
      const groupId = decrypt(impersonateCookieValue)
      const admin = createAdminClient()
      const { data: impGroup } = await admin
        .from('groups')
        .select('id, name, palette_id, slug')
        .eq('id', groupId)
        .single()

      if (impGroup) {
        impersonatedGroupName = impGroup.name
        // Override the displayed active group so palette + name render correctly
        activeGroup = impGroup as unknown as Group
      }
    } catch {
      // Cookie invalid or expired — ignore and continue with normal session
    }
  }

  // ── Permissions ─────────────────────────────────────────────────────────────
  const userRole = (activeUserGroup.role ?? 'viewer') as AppRole
  const permissions = await getUserPermissions(session.user.id, activeUserGroup.group_id, userRole)
  const visibleFeatures: FeatureKey[] = getVisibleFeatures(permissions)

  // ── Markets nav visibility (MKT-1) ──────────────────────────────────────────
  // The "Markets" sidebar entry only appears for Markets role holders (viewer /
  // manager) or super admins. Access is global, independent of the active group.
  const marketsAccess = await getMarketsAccess(supabase, session.user.id)
  const showMarkets   = canViewMarkets(marketsAccess)

  return (
    <>
      {/*
        Inject group primary colour server-side to prevent colour flash on
        hydration. This runs before any client JS executes.
      */}
      <style
        dangerouslySetInnerHTML={{
          __html: buildPaletteCSS(getPalette(activeGroup.palette_id)),
        }}
      />

      {/*
        Per-group brand accent (migration 047). Falls back to the palette's
        primary colour when no brand_color is set. Defined inline so the
        client-side useEffect in AppShell never causes a colour flash.
      */}
      <style
        dangerouslySetInnerHTML={{
          __html: `:root { --brand-color: ${
            (activeGroup as { brand_color?: string | null }).brand_color
              ?? getPalette(activeGroup.palette_id).primary
          }; }`,
        }}
      />

      {/* Impersonation banner — fixed at top, amber, above AppShell */}
      {impersonatedGroupName && (
        <ImpersonationBanner groupName={impersonatedGroupName} />
      )}

      <AppShell
        user={{ id: session.user.id, email: session.user.email! }}
        groups={typedGroups}
        activeGroup={activeGroup}
        visibleFeatures={visibleFeatures}
        userRole={userRole}
        showMarkets={showMarkets}
        // Push content down when impersonation banner is visible
        topOffset={impersonatedGroupName ? 36 : 0}
      >
        {children}
      </AppShell>
    </>
  )
}
