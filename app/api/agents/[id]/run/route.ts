import { NextResponse }     from 'next/server'
import { cookies }           from 'next/headers'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime     = 'nodejs'
export const maxDuration = 60

// ── POST /api/agents/[id]/run ─────────────────────────────────────────────────
// Creates an agent_run record in `queued` status and returns the run_id.
// Execution is performed by /api/cron/process-queued-runs (every minute) so
// the request lambda doesn't carry the long-running compute and risk being
// killed mid-execution by Vercel's 300 s cap.

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase   = createClient()
  const cookieStore = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  // Verify agent exists and user has access (RLS)
  const { data: agent } = await supabase
    .from('agents')
    .select('id, group_id, is_active')
    .eq('id', params.id)
    .eq('group_id', activeGroupId)
    .single()

  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  if (!agent.is_active) return NextResponse.json({ error: 'Agent is inactive' }, { status: 422 })

  let body: Record<string, unknown> = {}
  try { body = await request.json() } catch { /* body optional */ }

  const admin = createAdminClient()

  // ── Follow-up handling ──────────────────────────────────────────────────
  // If parent_run_id is supplied and belongs to the same group, prepend the
  // parent's output (sliced) to extra_instructions so the new run has the
  // prior context without the agent having to re-derive it.
  let extraInstructions = typeof body.extra_instructions === 'string'
    ? body.extra_instructions
    : (typeof body.brief === 'string' ? body.brief : undefined)

  let parentRunId: string | null = null
  if (typeof body.parent_run_id === 'string' && body.parent_run_id.length > 0) {
    const { data: parentRun } = await admin
      .from('agent_runs')
      .select('id, group_id, run_name, output')
      .eq('id', body.parent_run_id)
      .eq('group_id', activeGroupId)
      .maybeSingle()
    if (parentRun) {
      parentRunId = parentRun.id as string
      const parentName   = (parentRun.run_name as string | null) ?? 'Previous run'
      const parentOutput = (parentRun.output    as string | null) ?? ''
      extraInstructions = [
        extraInstructions ?? '',
        '',
        '## Your previous work on this task',
        `Run name: ${parentName}`,
        '',
        parentOutput.slice(0, 6000),
        '',
        'Continue from where you left off, building on this previous work. Do not repeat work already done.',
      ].join('\n')
    }
  }

  const insertData: Record<string, unknown> = {
    agent_id:          params.id,
    group_id:          activeGroupId,
    triggered_by:      'manual',
    triggered_by_user: session.user.id,
    status:            'queued',
    parent_run_id:     parentRunId,
    input_context:     {
      period:             typeof body.period      === 'string' ? body.period      : undefined,
      company_ids:        Array.isArray(body.company_ids) ? body.company_ids       : undefined,
      extra_instructions: extraInstructions,
    },
  }
  if (typeof body.run_name             === 'string') insertData.run_name             = body.run_name
  if (typeof body.output_type          === 'string') insertData.output_type          = body.output_type
  if (typeof body.output_folder_id     === 'string') insertData.output_folder_id     = body.output_folder_id
  if (typeof body.output_status        === 'string') insertData.output_status        = body.output_status
  if (typeof body.output_name_override === 'string') insertData.output_name_override = body.output_name_override
  if (body.notify_email === null || typeof body.notify_email === 'string')
    insertData.notify_email = body.notify_email
  if (body.notify_slack_channel === null || typeof body.notify_slack_channel === 'string')
    insertData.notify_slack_channel = body.notify_slack_channel
  if (Array.isArray(body.linked_document_ids)) {
    const ids = (body.linked_document_ids as unknown[]).filter((x): x is string => typeof x === 'string')
    insertData.linked_document_ids = ids
  }
  if (Array.isArray(body.linked_report_ids)) {
    const ids = (body.linked_report_ids as unknown[]).filter((x): x is string => typeof x === 'string')
    insertData.linked_report_ids = ids
  }
  if (typeof body.task_complexity === 'string'
      && ['standard', 'medium', 'large', 'massive', 'professional'].includes(body.task_complexity)) {
    insertData.task_complexity = body.task_complexity
    // Professional tier always pre-loads. Other tiers can opt in via the
    // explicit body flag below.
    if (body.task_complexity === 'professional') insertData.preload_context = true
  }
  if (body.preload_context === true) insertData.preload_context = true

  const { data: run, error } = await admin
    .from('agent_runs')
    .insert(insertData)
    .select('id')
    .single()

  if (error || !run) return NextResponse.json({ error: error?.message ?? 'Failed to create run' }, { status: 500 })

  // Run stays in `status: 'queued'`. The /api/cron/process-queued-runs cron
  // (every minute) claims it, flips it to `running` and drives execution
  // inside the cron lambda. Vercel Pro caps lambda duration at 300 s, so
  // doing the run inside this POST lambda risked the request being killed
  // mid-execution and the run sitting in `running` forever (covered by the
  // cleanup-stuck-runs cron, but with a 30-min UX delay).
  return NextResponse.json({ data: { run_id: run.id as string } }, { status: 201 })
}
