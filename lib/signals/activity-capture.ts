/**
 * Activity capture instrumentation for Sage Phase 1.
 *
 * Lightweight helper to emit activity_events at key points: agent run
 * start/completion, company/group create, permission errors, screen views.
 * Service-role only writes; super_admin read access for Sage.
 */

import { createAdminClient } from '@/lib/supabase/admin'

export interface ActivityContext {
  eventType:  'screen_view' | 'flow_start' | 'flow_complete' | 'flow_drop_off' | 'retry'
  flow:       string
  screen?:    string
  context?:   Record<string, unknown>
  userId?:    string
  groupId?:   string
  companyId?: string
  agentId?:   string
  runId?:     string
}

/**
 * Emit an activity event (best-effort, never throws).
 */
export async function captureActivity(ctx: ActivityContext): Promise<void> {
  try {
    const admin = createAdminClient()
    await admin.from('activity_events').insert({
      event_type: ctx.eventType,
      flow:       ctx.flow,
      screen:     ctx.screen ?? null,
      context:    ctx.context ?? null,
      user_id:    ctx.userId ?? null,
      group_id:   ctx.groupId ?? null,
      company_id: ctx.companyId ?? null,
      agent_id:   ctx.agentId ?? null,
      run_id:     ctx.runId ?? null,
    })
  } catch (err) {
    // Silent failure — activity capture must not throw
    console.error('[activity-capture] Failed to emit event:', err instanceof Error ? err.message : String(err))
  }
}
