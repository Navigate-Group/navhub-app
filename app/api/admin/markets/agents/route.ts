import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getAnalystConfig, saveAnalystConfig, ANALYST_MODELS, type AnalystConfigPatch } from '@/lib/markets/analyst'

/**
 * Admin Market Analyst config API (MKT-5). Super-admin only. Reads and updates
 * the singleton analyst config (enable/disable, model, prompts, suggested
 * questions, cache TTL). Changes apply immediately to new runs because the chat
 * route resolves config fresh on every request. Writes go through the
 * service-role admin client (RLS bypass); the super-admin check below is the gate.
 */

async function verifySuperAdmin(userId: string): Promise<boolean> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('user_groups')
    .select('role')
    .eq('user_id', userId)
    .eq('role', 'super_admin')
  return (data?.length ?? 0) > 0
}

export async function GET() {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!await verifySuperAdmin(session.user.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const config = await getAnalystConfig()
  return NextResponse.json({ data: config, models: ANALYST_MODELS })
}

export async function PUT(req: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!await verifySuperAdmin(session.user.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: Record<string, unknown>
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const patch: AnalystConfigPatch = {}
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  if (typeof body.model === 'string') patch.model = body.model
  if (typeof body.analysisPrompt === 'string') patch.analysisPrompt = body.analysisPrompt
  if (typeof body.chatPrompt === 'string') patch.chatPrompt = body.chatPrompt
  if (Array.isArray(body.suggestions)) {
    patch.suggestions = (body.suggestions as unknown[]).filter((s): s is string => typeof s === 'string')
  } else if (typeof body.suggestions === 'string') {
    // Accept a CSV string from the admin textarea.
    patch.suggestions = body.suggestions.split(',').map(s => s.trim()).filter(Boolean)
  }
  if (typeof body.cacheTtlHours === 'number') patch.cacheTtlHours = body.cacheTtlHours

  const config = await saveAnalystConfig(patch, session.user.id)

  void createAdminClient().from('admin_audit_log').insert({
    actor_id:    session.user.id,
    action:      'update_markets_agent_config',
    entity_type: 'markets_agent',
    entity_id:   'analyst',
    metadata:    { enabled: config.enabled, model: config.model, cache_ttl_hours: config.cacheTtlHours },
  })

  return NextResponse.json({ data: config })
}
