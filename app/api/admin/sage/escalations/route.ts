import { NextResponse }      from 'next/server'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getContractConfig, postEscalation } from '@/lib/sage-contract'

export const runtime = 'nodejs'

async function verifySuperAdminOrGroupOwner(userId: string): Promise<boolean> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('user_groups')
    .select('role')
    .eq('user_id', userId)
    .in('role', ['super_admin', 'group_owner'])
  return (data?.length ?? 0) > 0
}

// ── GET /api/admin/sage/escalations ──────────────────────────────────────────
// Query params:
//   status      — comma-separated list (optional, default: all)
//   priority    — comma-separated list (optional)
//   finding_id  — restrict to a specific finding (optional)
//   limit       — default 100, max 500
export async function GET(request: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!await verifySuperAdminOrGroupOwner(session.user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const url = new URL(request.url)
  const status    = (url.searchParams.get('status')   ?? '').split(',').filter(Boolean)
  const priority  = (url.searchParams.get('priority') ?? '').split(',').filter(Boolean)
  const findingId = url.searchParams.get('finding_id')
  const limit     = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 500)

  const admin = createAdminClient()
  let query = admin
    .from('sage_escalations')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (status.length > 0)   query = query.in('status', status)
  if (priority.length > 0) query = query.in('suggested_priority', priority)
  if (findingId)           query = query.eq('finding_id', findingId)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data: data ?? [] })
}

// ── POST /api/admin/sage/escalations ─────────────────────────────────────────
// Create a new escalation and send it to Builder via contract lane 4
// Body:
//   finding_id           — UUID of the finding being escalated (optional)
//   trigger_type         — 'review' | 'user_report' | 'suggestion' | 'admin_interaction'
//   summary              — Short summary
//   detail               — Full detail / context
//   suggested_priority   — 'low' | 'medium' | 'high' | 'critical'
//   source_context       — { scan_id?, finding_id?, user_id?, group_id? }
export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!await verifySuperAdminOrGroupOwner(session.user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const body = await request.json()
    const {
      finding_id,
      trigger_type,
      summary,
      detail,
      suggested_priority,
      source_context,
    } = body

    // Validate required fields
    if (!trigger_type || !summary || !detail || !suggested_priority) {
      return NextResponse.json(
        { error: 'Missing required fields: trigger_type, summary, detail, suggested_priority' },
        { status: 400 },
      )
    }

    if (!['review', 'user_report', 'suggestion', 'admin_interaction'].includes(trigger_type)) {
      return NextResponse.json({ error: 'Invalid trigger_type' }, { status: 400 })
    }

    if (!['low', 'medium', 'high', 'critical'].includes(suggested_priority)) {
      return NextResponse.json({ error: 'Invalid suggested_priority' }, { status: 400 })
    }

    const admin = createAdminClient()

    // If finding_id provided, load the finding to populate source_context
    let scanId: string | null = null
    if (finding_id) {
      const { data: finding } = await admin
        .from('sage_findings')
        .select('scan_id')
        .eq('id', finding_id)
        .single()
      scanId = finding?.scan_id ?? null
    }

    // Create escalation record
    const { data: escalation, error: insertError } = await admin
      .from('sage_escalations')
      .insert({
        scan_id: scanId,
        finding_id: finding_id ?? null,
        trigger_type,
        summary,
        detail,
        suggested_priority,
        status: 'drafted',
      })
      .select()
      .single()

    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 })
    }

    const escalationId = (escalation as { id: string }).id

    // Send escalation to Builder via contract lane 4
    try {
      const config = await getContractConfig()
      const payload = {
        trigger_type,
        summary,
        detail,
        suggested_priority,
        source_context: source_context ?? {},
        ts: new Date().toISOString(),
      }

      await postEscalation(config, payload)

      // Update escalation status to 'sent'
      await admin
        .from('sage_escalations')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          kaizen_escalation_id: escalationId, // Use our ID as the kaizen_escalation_id
        })
        .eq('id', escalationId)

      // If escalating a finding, update finding status to 'escalated'
      if (finding_id) {
        await admin
          .from('sage_findings')
          .update({
            status: 'acting',
            escalation_id: escalationId,
          })
          .eq('id', finding_id)
      }

      return NextResponse.json({
        data: {
          ...escalation,
          status: 'sent',
          sent_at: new Date().toISOString(),
        },
      })
    } catch (contractError) {
      // Contract POST failed — leave escalation in 'drafted' state
      console.error('[escalations] Contract POST failed:', contractError)
      return NextResponse.json(
        {
          error: 'Escalation created but failed to send to Builder',
          escalation_id: escalationId,
        },
        { status: 500 },
      )
    }
  } catch (err) {
    console.error('[escalations] POST error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
