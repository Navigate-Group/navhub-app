import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getTrackerContext } from '@/lib/tracker/server'
import type { ProposedChange, ProposedChangeItem, ApplyResult } from '@/lib/tracker/brief'

export const runtime = 'nodejs'

// POST /api/tracker/brief/apply — apply the ticked proposed changes.
// Body: { changes: ProposedChangeItem[] }  (only the lines the person kept
// ticked). Each change is validated (ids, lookup keys, dates) and then written
// through the SAME Supabase server client as the person, so the database's
// access rules (migration 082) decide exactly as on the normal screens. Each
// change succeeds or fails on its own; the response carries a per-line result.
export async function POST(request: Request) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase, groupId } = ctx

  let body: { changes?: ProposedChangeItem[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const items = Array.isArray(body.changes) ? body.changes : []
  if (items.length === 0) {
    return NextResponse.json({ error: 'No changes to apply' }, { status: 400 })
  }

  // Today in the group's time zone (for "contacted today" and waiting dates).
  const { data: todayVal } = await supabase.rpc('tracker_today', { p_group_id: groupId })
  const today = typeof todayVal === 'string' ? todayVal : new Date().toISOString().slice(0, 10)

  // Valid lookup keys per list — a proposed key that isn't real is rejected.
  const { data: lookupRows } = await supabase
    .from('tracker_lookups')
    .select('list, key')
    .eq('group_id', groupId)
  const validKeys = new Map<string, Set<string>>()
  for (const r of lookupRows ?? []) {
    const list = r.list as string
    if (!validKeys.has(list)) validKeys.set(list, new Set())
    validKeys.get(list)!.add(r.key as string)
  }

  const results: ApplyResult[] = []
  for (const item of items) {
    const id = typeof item?.id === 'string' ? item.id : ''
    try {
      const err = await applyOne(supabase, groupId, today, validKeys, item?.change)
      results.push(err ? { id, ok: false, error: err } : { id, ok: true })
    } catch {
      results.push({ id, ok: false, error: 'The change could not be saved' })
    }
  }

  return NextResponse.json({ results })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
function okDate(v: string | null | undefined): v is string {
  return typeof v === 'string' && ISO_DATE.test(v)
}
function cleanDate(v: string | null | undefined): string | null | undefined {
  if (v === null || v === undefined) return v
  return okDate(v) ? v : undefined
}
function keyOk(validKeys: Map<string, Set<string>>, list: string, key: string | null | undefined): boolean {
  if (key === null || key === undefined) return true
  return validKeys.get(list)?.has(key) ?? false
}

/**
 * Translate a Supabase write error or empty result into a short, plain message
 * — the same shape the tracker routes use (RLS refusals read as "you don't have
 * permission").
 */
function permissionMessage(error: { code?: string; message?: string } | null, empty: boolean): string | null {
  if (error) {
    if (
      error.code === '42501' ||
      error.code === 'PGRST301' ||
      (error.message && /row-level security/i.test(error.message))
    ) {
      return "You don't have permission to change this"
    }
    return error.message || 'The change could not be saved'
  }
  if (empty) return "You don't have permission to change this"
  return null
}

/**
 * Apply a single change through the server client. Returns an error string on
 * failure, or null on success. Mirrors the validation and writes of the
 * existing tracker routes (actions, milestones, updates, plans, contacts) so
 * the same rules apply — the database then enforces access.
 */
async function applyOne(
  supabase: SupabaseClient,
  groupId: string,
  today: string,
  validKeys: Map<string, Set<string>>,
  change: ProposedChange | undefined,
): Promise<string | null> {
  if (!change || typeof change !== 'object') return 'Unknown change'

  switch (change.kind) {
    case 'log_update': {
      if (!change.planId) return 'A project is required'
      if (!change.text?.trim()) return 'An update needs some text'
      if (!keyOk(validKeys, 'source', change.source)) return 'Unknown update source'
      const insert: Record<string, unknown> = {
        group_id: groupId,
        plan_id: change.planId,
        text: change.text.trim(),
        source: change.source ?? null,
      }
      if (okDate(change.date)) insert.date = change.date
      const { error } = await supabase.from('tracker_updates').insert(insert).select('id').single()
      return permissionMessage(error, false)
    }

    case 'add_action': {
      if (!change.planId) return 'A project is required'
      if (!change.title?.trim()) return 'An action title is required'
      if (!keyOk(validKeys, 'action_type', change.type)) return 'Unknown action type'
      const insert: Record<string, unknown> = {
        group_id: groupId,
        plan_id: change.planId,
        title: change.title.trim(),
        type: change.type ?? null,
        who: change.who ?? null,
        assignee_id: change.assigneeId ?? null,
        due_on: cleanDate(change.dueOn) ?? null,
        status: 'open',
        priority: 'normal',
        milestone_id: change.milestoneId ?? null,
        contact_id: change.contactId ?? null,
      }
      const { error } = await supabase.from('tracker_actions').insert(insert).select('id').single()
      return permissionMessage(error, false)
    }

    case 'update_action': {
      if (!change.actionId) return 'An action is required'
      const patch: Record<string, unknown> = {}
      if (change.status) patch.status = change.status
      if (change.dueOn !== undefined && change.dueOn !== null) {
        if (!okDate(change.dueOn)) return 'Invalid due date'
        patch.due_on = change.dueOn
      }
      if (change.assigneeId !== undefined) patch.assignee_id = change.assigneeId
      if (change.title) patch.title = change.title.trim()
      if (Object.keys(patch).length === 0) return 'Nothing to update'
      const { data, error } = await supabase
        .from('tracker_actions')
        .update(patch)
        .eq('id', change.actionId)
        .select('id')
      return permissionMessage(error, !data || data.length === 0)
    }

    case 'add_milestone': {
      if (!change.planId) return 'A project is required'
      if (!change.title?.trim()) return 'A milestone title is required'
      if (!keyOk(validKeys, 'milestone_status', change.status)) return 'Unknown milestone status'
      const insert: Record<string, unknown> = {
        group_id: groupId,
        plan_id: change.planId,
        title: change.title.trim(),
        status: change.status ?? 'backlog',
        due_on: cleanDate(change.dueOn) ?? null,
        progress_pct: clampPct(change.progressPct) ?? 0,
      }
      const { error } = await supabase.from('tracker_milestones').insert(insert).select('id').single()
      return permissionMessage(error, false)
    }

    case 'update_milestone': {
      if (!change.milestoneId) return 'A milestone is required'
      if (!keyOk(validKeys, 'milestone_status', change.status)) return 'Unknown milestone status'
      const patch: Record<string, unknown> = {}
      if (change.status) patch.status = change.status
      if (change.dueOn !== undefined && change.dueOn !== null) {
        if (!okDate(change.dueOn)) return 'Invalid due date'
        patch.due_on = change.dueOn
      }
      const pct = clampPct(change.progressPct)
      if (pct !== undefined) patch.progress_pct = pct
      if (Object.keys(patch).length === 0) return 'Nothing to update'
      const { data, error } = await supabase
        .from('tracker_milestones')
        .update(patch)
        .eq('id', change.milestoneId)
        .select('id')
      return permissionMessage(error, !data || data.length === 0)
    }

    case 'update_plan': {
      if (!change.planId) return 'A project is required'
      if (!keyOk(validKeys, 'status', change.status)) return 'Unknown project status'
      const patch: Record<string, unknown> = {}
      if (change.status) patch.status = change.status
      if (change.phase !== undefined) patch.phase = change.phase
      if (change.summary !== undefined) patch.summary = change.summary
      if (change.priority) patch.priority = change.priority
      const pct = clampPct(change.progressPct)
      if (pct !== undefined) patch.progress_pct = pct
      if (change.startOn !== undefined && change.startOn !== null) {
        if (!okDate(change.startOn)) return 'Invalid start date'
        patch.start_on = change.startOn
      }
      if (change.endOn !== undefined && change.endOn !== null) {
        if (!okDate(change.endOn)) return 'Invalid end date'
        patch.end_on = change.endOn
      }
      if (Object.keys(patch).length === 0) return 'Nothing to update'
      const { data, error } = await supabase
        .from('tracker_project_plans')
        .update(patch)
        .eq('id', change.planId)
        .select('id')
      return permissionMessage(error, !data || data.length === 0)
    }

    case 'add_contact': {
      if (!change.planId) return 'A project is required'
      if (!change.name?.trim()) return 'A contact name is required'
      const { data: created, error: createErr } = await supabase
        .from('tracker_contacts')
        .insert({
          group_id: groupId,
          name: change.name.trim(),
          org: change.org ?? null,
          role: change.role ?? null,
          phone: change.phone ?? null,
          email: change.email ?? null,
        })
        .select('id')
        .single()
      if (createErr) return permissionMessage(createErr, false)
      const { error: linkErr } = await supabase
        .from('tracker_contact_plans')
        .upsert(
          { contact_id: created.id as string, plan_id: change.planId, group_id: groupId },
          { onConflict: 'contact_id,plan_id', ignoreDuplicates: true },
        )
      return permissionMessage(linkErr, false)
    }

    case 'link_contact': {
      if (!change.planId) return 'A project is required'
      if (!change.contactId) return 'A contact is required'
      const { error } = await supabase
        .from('tracker_contact_plans')
        .upsert(
          { contact_id: change.contactId, plan_id: change.planId, group_id: groupId },
          { onConflict: 'contact_id,plan_id', ignoreDuplicates: true },
        )
      return permissionMessage(error, false)
    }

    case 'contacted_today': {
      if (!change.contactId) return 'A contact is required'
      const { data, error } = await supabase
        .from('tracker_contacts')
        .update({ last_contact: today })
        .eq('id', change.contactId)
        .select('id')
      return permissionMessage(error, !data || data.length === 0)
    }

    default:
      return 'Unknown change'
  }
}

function clampPct(v: number | null | undefined): number | undefined {
  if (v === null || v === undefined || !Number.isFinite(v)) return undefined
  return Math.max(0, Math.min(100, Math.round(v)))
}
