import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getTrackerContext, isEditor, applyPlanMembers } from '@/lib/tracker/server'
import { addDays } from '@/lib/tracker/domain'
import {
  type ProposedChange,
  type ProposedChangeItem,
  type ApplyResult,
  buildActionPatch,
  buildMilestonePatch,
  buildPlanPatch,
  buildContactPatch,
  createProjectRefusal,
  clampPct,
} from '@/lib/tracker/brief'

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
  const { supabase, groupId, userId } = ctx

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

  // Today in the group's time zone (for "contacted today" and waiting dates),
  // plus the group's chaser setting (the default chase date for Waiting — same
  // as the quick button in app/api/tracker/actions/[id]/route.ts).
  const [{ data: todayVal }, { data: settingsRow }] = await Promise.all([
    supabase.rpc('tracker_today', { p_group_id: groupId }),
    supabase.from('tracker_settings').select('chaser_days').eq('group_id', groupId).maybeSingle(),
  ])
  const today = typeof todayVal === 'string' ? todayVal : new Date().toISOString().slice(0, 10)
  const chaserDays = typeof settingsRow?.chaser_days === 'number' ? settingsRow.chaser_days : 5

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

  // Managers/Group Owners may create projects; others are refused at apply time
  // (the database also refuses them, but we check up front for a clear message).
  // Resolved once, only when a create_project is actually present.
  const hasCreate = items.some((i) => i?.change?.kind === 'create_project')
  const editor = hasCreate ? await isEditor(supabase, groupId) : false

  const results: ApplyResult[] = []
  for (const item of items) {
    const id = typeof item?.id === 'string' ? item.id : ''
    try {
      const err = await applyOne(supabase, {
        groupId,
        userId,
        today,
        chaserDays,
        validKeys,
        editor,
        change: item?.change,
      })
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
 * The plain-words "couldn't be found" line for an item the change references.
 * Shown when a pre-check finds no readable row for the id — i.e. the id is
 * wrong, or the person can't see it at all — as opposed to a genuine RLS write
 * refusal on a row they CAN see (which keeps the permission message).
 */
type ItemType = 'action' | 'milestone' | 'project' | 'contact'
function notFoundMessage(type: ItemType): string {
  return `That ${type} couldn't be found. Try the briefing again.`
}

/**
 * Pre-check that the referenced row exists and is readable by the person (the
 * SELECT runs through their own server client, so RLS scopes it). Returns a
 * "couldn't be found" message when there is no readable row, or null to proceed.
 * A genuine write refusal on a row they CAN read is left to the update's own
 * permissionMessage, which keeps the "you don't have permission" line.
 */
async function ensureReadable(
  supabase: SupabaseClient,
  groupId: string,
  table: string,
  id: string,
  type: ItemType,
): Promise<string | null> {
  const { data } = await supabase
    .from(table)
    .select('id')
    .eq('group_id', groupId)
    .eq('id', id)
    .maybeSingle()
  return data ? null : notFoundMessage(type)
}

/**
 * Apply a single change through the server client. Returns an error string on
 * failure, or null on success. Mirrors the validation and writes of the
 * existing tracker routes (actions, milestones, updates, plans, contacts) so
 * the same rules apply — the database then enforces access.
 */
async function applyOne(
  supabase: SupabaseClient,
  opts: {
    groupId: string
    userId: string
    today: string
    chaserDays: number
    validKeys: Map<string, Set<string>>
    editor: boolean
    change: ProposedChange | undefined
  },
): Promise<string | null> {
  const { groupId, userId, today, chaserDays, validKeys, editor, change } = opts
  if (!change || typeof change !== 'object') return 'Unknown change'

  switch (change.kind) {
    case 'log_update': {
      if (!change.planId) return 'A project is required'
      if (!change.text?.trim()) return 'An update needs some text'
      const nf = await ensureReadable(supabase, groupId, 'tracker_project_plans', change.planId, 'project')
      if (nf) return nf
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
      const nf = await ensureReadable(supabase, groupId, 'tracker_project_plans', change.planId, 'project')
      if (nf) return nf
      // A named milestone/contact to attach must exist and be readable too.
      if (change.milestoneId) {
        const mNf = await ensureReadable(supabase, groupId, 'tracker_milestones', change.milestoneId, 'milestone')
        if (mNf) return mNf
      }
      if (change.contactId) {
        const cNf = await ensureReadable(supabase, groupId, 'tracker_contacts', change.contactId, 'contact')
        if (cNf) return cNf
      }
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
      const nf = await ensureReadable(supabase, groupId, 'tracker_actions', change.actionId, 'action')
      if (nf) return nf
      let patch: Record<string, unknown>
      try {
        patch = buildActionPatch(change)
      } catch {
        return 'Invalid due date'
      }
      // Waiting with no due date given gets the usual chase date (today +
      // chaser days) — same as the Waiting quick button on an action.
      if (change.status === 'waiting' && patch.due_on === undefined) {
        patch.due_on = addDays(today, chaserDays)
      }
      if (Object.keys(patch).length === 0) return 'Nothing to update'

      // Read the status before the save so "Last spoke" only moves when the
      // action *becomes* Done — mirrors app/api/tracker/actions/[id]/route.ts.
      const { data: before } = await supabase
        .from('tracker_actions')
        .select('status')
        .eq('id', change.actionId)
        .maybeSingle()
      const wasDone = (before?.status as string | null) === 'done'

      const { data, error } = await supabase
        .from('tracker_actions')
        .update(patch)
        .eq('id', change.actionId)
        .select('id, status, type, contact_id')
      const msg = permissionMessage(error, !data || data.length === 0)
      if (msg) return msg

      // When a call or email action *becomes* Done and has a contact, move that
      // contact's last-contact date to today (best-effort, like the quick
      // button — skipped quietly if the person can't change the contact).
      const updated = (data?.[0] ?? {}) as {
        status?: string
        type?: string | null
        contact_id?: string | null
      }
      if (
        !wasDone &&
        updated.status === 'done' &&
        updated.contact_id &&
        (updated.type === 'call' || updated.type === 'email')
      ) {
        await supabase
          .from('tracker_contacts')
          .update({ last_contact: today })
          .eq('id', updated.contact_id)
      }
      return null
    }

    case 'add_milestone': {
      if (!change.planId) return 'A project is required'
      if (!change.title?.trim()) return 'A milestone title is required'
      const nf = await ensureReadable(supabase, groupId, 'tracker_project_plans', change.planId, 'project')
      if (nf) return nf
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
      const nf = await ensureReadable(supabase, groupId, 'tracker_milestones', change.milestoneId, 'milestone')
      if (nf) return nf
      if (!keyOk(validKeys, 'milestone_status', change.status)) return 'Unknown milestone status'
      let patch: Record<string, unknown>
      try {
        patch = buildMilestonePatch(change)
      } catch {
        return 'Invalid due date'
      }
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
      const nf = await ensureReadable(supabase, groupId, 'tracker_project_plans', change.planId, 'project')
      if (nf) return nf
      if (!keyOk(validKeys, 'status', change.status)) return 'Unknown project status'
      let patch: Record<string, unknown>
      try {
        patch = buildPlanPatch(change)
      } catch (e) {
        return e instanceof Error ? e.message : 'Invalid date'
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
      const nf = await ensureReadable(supabase, groupId, 'tracker_project_plans', change.planId, 'project')
      if (nf) return nf
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
      const planNf = await ensureReadable(supabase, groupId, 'tracker_project_plans', change.planId, 'project')
      if (planNf) return planNf
      const contactNf = await ensureReadable(supabase, groupId, 'tracker_contacts', change.contactId, 'contact')
      if (contactNf) return contactNf
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
      const nf = await ensureReadable(supabase, groupId, 'tracker_contacts', change.contactId, 'contact')
      if (nf) return nf
      const { data, error } = await supabase
        .from('tracker_contacts')
        .update({ last_contact: today })
        .eq('id', change.contactId)
        .select('id')
      return permissionMessage(error, !data || data.length === 0)
    }

    case 'create_project': {
      // Managers / Group Owners only — refused up front for everyone else (the
      // database also refuses, but this gives a clear line). Mirrors the logic
      // of POST /api/tracker/plans: required name/category, validated lookup
      // keys, an EXISTING visible parent, owned by the person applying.
      const refusal = createProjectRefusal(change, editor)
      if (refusal) return refusal
      if (!keyOk(validKeys, 'category', change.category)) return 'Unknown category'
      if (!keyOk(validKeys, 'status', change.status)) return 'Unknown project status'
      if (!keyOk(validKeys, 'region', change.region)) return 'Unknown region'

      // The parent must be an EXISTING project the person can see; never invent
      // one. A parent id the person can't read returns no row here.
      if (change.parentId) {
        const { data: parent } = await supabase
          .from('tracker_project_plans')
          .select('id')
          .eq('group_id', groupId)
          .eq('id', change.parentId)
          .maybeSingle()
        if (!parent) {
          return "That parent project doesn't exist — create it first, or pick an existing one"
        }
      }

      const insert: Record<string, unknown> = {
        group_id: groupId,
        name: change.name.trim(),
        category: change.category,
        status: change.status ?? null,
        client: change.client ?? null,
        phase: change.phase ?? null,
        summary: change.summary ?? null,
        region: change.region ?? null,
        parent_id: change.parentId ?? null,
        owner_id: userId,
        lead_id: change.leadId ?? null,
        priority: 'normal',
        progress_pct: 0,
      }
      const { data: created, error } = await supabase
        .from('tracker_project_plans')
        .insert(insert)
        .select('id')
        .single()
      if (error) return permissionMessage(error, false)

      // Members (role = 'member'), same helper the plans route uses. Only
      // Managers/Group Owners may; a refusal is reported but the project stands.
      if (change.memberIds && change.memberIds.length > 0 && created?.id) {
        const memberErr = await applyPlanMembers(supabase, created.id as string, change.memberIds)
        if (memberErr) return 'The project was created, but its members could not be saved'
      }
      return null
    }

    case 'update_contact': {
      if (!change.contactId) return 'A contact is required'
      const nf = await ensureReadable(supabase, groupId, 'tracker_contacts', change.contactId, 'contact')
      if (nf) return nf
      // Same "omit what wasn't given" rule as the project/action patches: only
      // the fields the person mentioned are written; the rest are left as they
      // were. Mirrors PATCH /api/tracker/contacts/[id].
      const patch = buildContactPatch(change)
      if (Object.keys(patch).length === 0) return 'Nothing to update'
      const { data, error } = await supabase
        .from('tracker_contacts')
        .update(patch)
        .eq('id', change.contactId)
        .select('id')
      return permissionMessage(error, !data || data.length === 0)
    }

    case 'add_comment': {
      if (!change.planId) return 'A project is required'
      if (!change.text?.trim()) return 'A comment needs some text'
      const nf = await ensureReadable(supabase, groupId, 'tracker_project_plans', change.planId, 'project')
      if (nf) return nf
      // Project comment, same shape as POST /api/tracker/comments. RLS requires
      // comment (or edit) access, or a Manager role — a refusal reads as the
      // usual permission message.
      const { error } = await supabase
        .from('tracker_comments')
        .insert({
          group_id: groupId,
          plan_id: change.planId,
          entity_type: 'plan',
          entity_id: change.planId,
          author_id: userId,
          body: change.text.trim(),
        })
        .select('id')
        .single()
      return permissionMessage(error, false)
    }

    default:
      return 'Unknown change'
  }
}
