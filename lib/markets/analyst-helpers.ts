/**
 * Market Analyst pure helpers (MKT-5).
 * ──────────────────────────────────────────────────────────────────────────
 * Dependency-free figure-attribution helpers, split out from the server-only
 * `analyst.ts` (which imports Next/Supabase) so they can be unit-tested under
 * the native Node test runner and imported anywhere without side effects.
 *
 * "Attribution" tags every quoted number with its season and whether it was
 * forward-filled (and from which season), so the agent can cite it faithfully.
 */

import type { Figure } from './compute'

/**
 * A short attribution string for a resolved Figure: its season plus whether it
 * was forward-filled (and from where), e.g.:
 *   "2024 figure"
 *   "2024 figure, filled (carried forward from 2022)"
 */
export function figureAttribution(fig: Pick<Figure, 'season' | 'filled' | 'filledFrom'>): string {
  if (!fig.filled) return `${fig.season} figure`
  return fig.filledFrom
    ? `${fig.season} figure, filled (carried forward from ${fig.filledFrom})`
    : `${fig.season} figure, filled`
}

/** Attribution for a possibly-null value cell carrying fill metadata. */
export function cellAttribution(season: string, filled: boolean, filledFrom?: string): string {
  if (!filled) return `${season} figure`
  return filledFrom
    ? `${season} figure, filled (carried forward from ${filledFrom})`
    : `${season} figure, filled`
}
