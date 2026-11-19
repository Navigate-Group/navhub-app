/**
 * Tracker API helpers (P5) — server-only utilities shared by the route
 * handlers under app/api/tracker/.
 */

import { NextResponse } from 'next/server'
import type { PostgrestError } from '@supabase/supabase-js'

/**
 * Turn a Supabase/Postgres write error into a clear HTTP response. RLS refusals
 * surface as either a 42501 (insufficient privilege, raised by guards) or an
 * empty result from a blocked INSERT/UPDATE — both shown as a 403 with a plain
 * message. Everything else is a 500 carrying the DB message.
 */
export function writeErrorResponse(error: PostgrestError): NextResponse {
  // Postgres "insufficient privilege" and RLS violations.
  if (error.code === '42501' || error.code === 'PGRST301' || /row-level security/i.test(error.message)) {
    return NextResponse.json(
      { error: "You don't have permission to change this project" },
      { status: 403 },
    )
  }
  // Guard RAISE EXCEPTIONs carry a readable message.
  if (error.message) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }
  return NextResponse.json({ error: 'The change could not be saved' }, { status: 500 })
}

/** Trim a string body field, returning null for empty/non-strings. */
export function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

/** Clamp an integer between min and max, or null when not a finite number. */
export function intInRange(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n)) return null
  return Math.max(min, Math.min(max, Math.round(n)))
}

/** A de-duplicated array of non-empty trimmed strings, or null when not an array. */
export function strArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const out = new Set<string>()
  for (const item of v) {
    if (typeof item === 'string') {
      const t = item.trim()
      if (t) out.add(t)
    }
  }
  return [...out]
}
