import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAnalystConfig } from '@/lib/markets/analyst'

/**
 * Market Analyst public config (MKT-5).
 * GET /api/markets/analyst/config
 *
 * Returns ONLY the fields the viewer-facing panel needs: whether the agent is
 * enabled and the suggested-question chips. Prompts, model and usage are never
 * exposed here — those are operator-only (see /api/admin/markets/agents).
 * Access is gated upstream by middleware (markets_viewer+).
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const config = await getAnalystConfig()
  return NextResponse.json({
    enabled: config.enabled,
    suggestions: config.suggestions,
  })
}
