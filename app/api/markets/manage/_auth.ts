import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getMarketsAccess, canManageMarkets } from '@/lib/markets'

/**
 * Shared manager-gate for the Markets curation API (MKT-6).
 *
 * The middleware already hard-403s non-managers on /api/markets/manage/*; this
 * is defence-in-depth AND the way each handler obtains the acting user id for
 * the audit log. Returns either the acting user id, or a ready-to-return 401/403.
 */
export async function requireManager(): Promise<
  | { userId: string; error?: undefined }
  | { error: NextResponse; userId?: undefined }
> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { error: NextResponse.json({ error: 'Unauthorised' }, { status: 401 }) }
  }
  const access = await getMarketsAccess(supabase, user.id)
  if (!canManageMarkets(access)) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { userId: user.id }
}

/** Parse a JSON request body, returning {} on any error. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json()
    return (body && typeof body === 'object') ? body as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Coerce a value to a trimmed non-empty string, or null. */
export function str(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length ? t : null
}

/** Coerce a value to a finite number, or null. */
export function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}
