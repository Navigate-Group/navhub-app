import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  getMarketsAccess,
  canViewMarkets,
  getMarketsTheme,
  setMarketsTheme,
  parseMarketsTheme,
} from '@/lib/markets'

export const runtime = 'nodejs'

/**
 * Per-user Markets preferences (MKT-2).
 *
 *   GET /api/markets/preferences  → { theme: 'light' | 'dark' | 'auto' }
 *   PUT /api/markets/preferences  body { theme } → persists + echoes it back
 *
 * Any Markets role holder (viewer+) may read and set their OWN preference.
 * Persistence is on the user's user_settings row (column markets_theme);
 * writes honour the "Users manage own settings" RLS policy.
 */

async function requireViewer() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorised' }, { status: 401 }) }
  const access = await getMarketsAccess(supabase, user.id)
  if (!canViewMarkets(access)) {
    return { error: NextResponse.json({ error: 'Markets access required' }, { status: 403 }) }
  }
  return { supabase, userId: user.id }
}

export async function GET() {
  const ctx = await requireViewer()
  if ('error' in ctx) return ctx.error
  const theme = await getMarketsTheme(ctx.supabase, ctx.userId)
  return NextResponse.json({ theme })
}

export async function PUT(req: Request) {
  const ctx = await requireViewer()
  if ('error' in ctx) return ctx.error

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* ignore */ }

  const theme = parseMarketsTheme(body.theme)
  if (!theme) {
    return NextResponse.json(
      { error: 'Invalid theme; expected one of light | dark | auto' },
      { status: 400 },
    )
  }

  const saved = await setMarketsTheme(ctx.supabase, ctx.userId, theme)
  return NextResponse.json({ theme: saved })
}
