import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest }          from 'next/server'

export async function middleware(request: NextRequest) {
  const hostname = request.headers.get('host') ?? ''
  const isMarketingSite = hostname.startsWith('www.') || hostname === 'navhub.co'

  // Marketing site — serve marketing pages, no auth required
  if (isMarketingSite) {
    return NextResponse.next()
  }

  let response = NextResponse.next({
    request: { headers: request.headers },
  })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value
        },
        set(name: string, value: string, options: CookieOptions) {
          request.cookies.set({ name, value, ...options })
          response = NextResponse.next({ request: { headers: request.headers } })
          response.cookies.set({ name, value, ...options })
        },
        remove(name: string, options: CookieOptions) {
          request.cookies.set({ name, value: '', ...options })
          response = NextResponse.next({ request: { headers: request.headers } })
          response.cookies.set({ name, value: '', ...options })
        },
      },
    }
  )

  // Refresh session — critical for SSR cookie sync
  const { data: { session } } = await supabase.auth.getSession()
  const { pathname } = request.nextUrl

  // Public routes — no auth required
  const isPublic =
    pathname === '/login'                       ||
    pathname === '/forgot-password'             ||
    pathname === '/reset-password'              ||
    pathname === '/no-group'                    ||
    pathname === '/landing'                     ||
    pathname === '/access-denied'               ||
    pathname.startsWith('/api/groups/switch')   ||
    pathname.startsWith('/accept-invite')       ||
    // New-user password-setup landing (and shared password-reset target).
    // Reached after /auth/callback exchanges an invite OTP — at that point
    // the user has a session but no password yet.
    pathname.startsWith('/set-password')        ||
    // Two-step invite landing — bypasses Outlook Safe Links by serving a
    // static page; the real action_link is held server-side and only
    // returned via POST /api/invite/[token]/accept.
    pathname.startsWith('/invite/')             ||
    pathname.startsWith('/api/invite/')         ||
    // PKCE / magic-link callback — exchanges code for session, claims invites
    pathname.startsWith('/auth/')               ||
    pathname.startsWith('/api/cron/')           ||
    pathname.startsWith('/api/auth')            ||
    pathname.startsWith('/_next')              ||
    // Standalone report viewer — allows token-based unauthenticated access
    pathname.startsWith('/view/report/')        ||
    // Standalone document viewer — allows token-based unauthenticated access
    pathname.startsWith('/view/document/')      ||
    // Public file endpoint — serves shared reports via token
    pathname.startsWith('/api/reports/public/') ||
    // Marketing site — public pages and API routes
    pathname === '/'                            ||
    pathname === '/demo'                        ||
    pathname === '/contact'                     ||
    pathname === '/security'                    ||
    pathname === '/enterprise'                  ||
    pathname === '/pricing'                     ||
    pathname.startsWith('/api/marketing/')      ||
    // SharePoint OAuth callback — Microsoft redirects unauthenticated
    pathname.startsWith('/api/integrations/sharepoint/callback') ||
    // SharePoint setup — called from popup after OAuth, no session cookie guaranteed
    pathname.startsWith('/api/integrations/sharepoint/setup') ||
    // SharePoint folder picker — called from popup wizard, no session cookie guaranteed
    pathname.startsWith('/api/integrations/sharepoint/folders') ||
    // Slack OAuth callback — Slack redirects unauthenticated
    pathname.startsWith('/api/integrations/slack/callback') ||
    // Sage contract lanes — Builder needs to reach inbound endpoints (HMAC-auth)
    pathname.startsWith('/api/sage/')

  if (isPublic) {
    // Redirect authenticated users away from login — EXCEPT new invitees
    // landing on the Set Up Account form (/login?setup=true). They already
    // have a live session from the just-completed invite OTP exchange (see
    // app/auth/callback/route.ts) but still need to choose a password, so
    // they must be allowed to reach /login to use that session.
    const isInviteSetup = request.nextUrl.searchParams.get('setup') === 'true'
    if (pathname === '/login' && session && !isInviteSetup) {
      return NextResponse.redirect(new URL('/dashboard', request.url))
    }

    return response
  }

  // Unauthenticated → /login
  if (!session) {
    const loginUrl = new URL('/login', request.url)
    return NextResponse.redirect(loginUrl)
  }

  // ── Admin route protection ────────────────────────────────────────────────────
  // /admin/** pages and /api/admin/** routes require super_admin role.
  const isAdminRoute =
    pathname.startsWith('/admin') ||
    pathname.startsWith('/api/admin/')

  if (isAdminRoute) {
    const { data: adminCheck } = await supabase
      .from('user_groups')
      .select('role')
      .eq('user_id', session.user.id)
      .eq('role', 'super_admin')
      .limit(1)

    if (!adminCheck || adminCheck.length === 0) {
      return NextResponse.redirect(new URL('/dashboard', request.url))
    }
  }

  // ── Markets access enforcement (MKT-1) ────────────────────────────────────────
  // Markets is a role-gated area backed by `market_user_roles`, independent of
  // per-group roles. Super admins always pass. For the manage sub-tree and its
  // API, a markets_manager (or super admin) is required; everything else under
  // /markets needs at least markets_viewer.
  const isMarketsPage   = pathname === '/markets' || pathname.startsWith('/markets/')
  const isMarketsApi    = pathname.startsWith('/api/markets/')
  if (isMarketsPage || isMarketsApi) {
    const needsManager =
      pathname.startsWith('/markets/manage') ||
      pathname.startsWith('/api/markets/manage')

    // Resolve effective access inline (avoids importing server-only helpers
    // that pull in the service-role admin client into the edge middleware).
    const { data: superRows } = await supabase
      .from('user_groups')
      .select('role')
      .eq('user_id', session.user.id)
      .eq('role', 'super_admin')
      .limit(1)
    const isSuper = (superRows?.length ?? 0) > 0

    let hasViewer = isSuper
    let hasManager = isSuper
    if (!isSuper) {
      const { data: marketRoles } = await supabase
        .from('market_user_roles')
        .select('role')
        .eq('user_id', session.user.id)
        .is('revoked_at', null)
      const roles = new Set((marketRoles ?? []).map(r => (r as { role: string }).role))
      hasManager = roles.has('markets_manager')
      hasViewer  = hasManager || roles.has('markets_viewer')
    }

    if (needsManager && !hasManager) {
      // Curation surfaces: hard 403 (no silent redirect) per the brief.
      if (isMarketsApi) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
      return new NextResponse('Forbidden', { status: 403 })
    }

    if (!needsManager && !hasViewer) {
      if (isMarketsApi) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
      // Non-Markets users are bounced to the app root with an error flag.
      const home = new URL('/', request.url)
      home.searchParams.set('error', 'markets_access')
      return NextResponse.redirect(home)
    }
  }

  // ── Impersonation write-block ─────────────────────────────────────────────────
  // During impersonation, block all mutating API calls except:
  //   DELETE /api/admin/impersonate  (exit impersonation)
  const impersonateCookie = request.cookies.get('navhub_impersonate_group')?.value
  const method = request.method.toUpperCase()

  if (
    impersonateCookie &&
    ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) &&
    pathname.startsWith('/api/')
  ) {
    // Allow admin routes and exiting impersonation
    if (
      pathname.startsWith('/api/admin/') ||
      (pathname === '/api/admin/impersonate' && method === 'DELETE')
    ) {
      return response
    }

    return NextResponse.json(
      { error: 'Writes are disabled while impersonating a group. Exit impersonation first.' },
      { status: 403 }
    )
  }

  // ── Feature-level access enforcement ──────────────────────────────────────────
  // Non-admin users must have a permission row for the feature matching this route.
  const FEATURE_ROUTES = [
    { prefix: '/cashflow',    feature: 'financials' },
    { prefix: '/forecasting', feature: 'financials' },
    { prefix: '/reports',     feature: 'reports'    },
    { prefix: '/documents',   feature: 'documents'  },
    { prefix: '/marketing',   feature: 'marketing'  },
    { prefix: '/agents',      feature: 'agents'     },
    { prefix: '/settings',    feature: 'settings'   },
  ]

  const matchedFeature = FEATURE_ROUTES.find(r => pathname.startsWith(r.prefix))
  const activeGroupId = request.cookies.get('active_group_id')?.value

  if (matchedFeature && activeGroupId && !isAdminRoute) {
    const { data: roleRow } = await supabase
      .from('user_groups')
      .select('role')
      .eq('user_id', session.user.id)
      .eq('group_id', activeGroupId)
      .single()

    const role = roleRow?.role ?? 'viewer'
    const adminRoles = ['super_admin', 'group_owner', 'group_admin']
    if (!adminRoles.includes(role)) {
      const { data: perms } = await supabase
        .from('user_permissions')
        .select('access')
        .eq('user_id', session.user.id)
        .eq('group_id', activeGroupId)
        .eq('feature', matchedFeature.feature)
        .is('company_id', null)
        .single()

      if (!perms || perms.access === 'none') {
        return NextResponse.redirect(new URL('/access-denied', request.url))
      }
    }
  }

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
