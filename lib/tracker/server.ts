/**
 * Tracker server helpers (P5) — server-only.
 * ──────────────────────────────────────────────────────────────────────────
 * The database is the guard: every tracker read and write runs as the
 * signed-in user through the Supabase server client, so RLS from migration
 * 082 decides what is allowed. The single admin-client exception is looking
 * up people's display names (see getGroupPeople), and only after the
 * server-client membership check.
 */

import { cookies } from 'next/headers'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export type TrackerContext = {
  supabase: SupabaseClient
  userId: string
  groupId: string
}

/**
 * Resolve the signed-in user and current group from the active_group_id
 * cookie, with the is_default fallback (CLAUDE.md Gotcha 11). Returns null
 * when there is no session or no resolvable group.
 */
export async function getTrackerContext(): Promise<TrackerContext | null> {
  const supabase = createClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return null

  const cookieStore = cookies()
  let groupId = cookieStore.get('active_group_id')?.value

  if (!groupId) {
    const { data: defaultGroup } = await supabase
      .from('user_groups')
      .select('group_id')
      .eq('user_id', session.user.id)
      .eq('is_default', true)
      .single()
    if (defaultGroup) groupId = defaultGroup.group_id
  }

  if (!groupId) return null

  return { supabase, userId: session.user.id, groupId }
}

/** Is the signed-in user a Manager or Group Owner of the group? (RPC) */
export async function isEditor(supabase: SupabaseClient, groupId: string): Promise<boolean> {
  const { data } = await supabase.rpc('tracker_is_editor', { p_group_id: groupId })
  return data === true
}

/** Can the signed-in user access a plan at the given level? (RPC) */
export async function canAccess(
  supabase: SupabaseClient,
  planId: string,
  level: 'view' | 'comment' | 'edit',
): Promise<boolean> {
  const { data } = await supabase.rpc('tracker_can_access', { p_plan_id: planId, p_level: level })
  return data === true
}

export type GroupSetupState =
  | { state: 'ready' }
  | { state: 'not_set_up' }
  | { state: 'error'; message: string }

/**
 * Ensure the group has a tracker_settings row. If missing and the user is an
 * editor, bootstrap it via tracker_init_group. Non-editors on an un-set-up
 * group get 'not_set_up'. The RPC itself is editor-guarded in the database.
 */
export async function ensureGroupSetup(ctx: TrackerContext): Promise<GroupSetupState> {
  const { supabase, groupId } = ctx
  const { data: settings } = await supabase
    .from('tracker_settings')
    .select('group_id')
    .eq('group_id', groupId)
    .maybeSingle()

  if (settings) return { state: 'ready' }

  const editor = await isEditor(supabase, groupId)
  if (!editor) return { state: 'not_set_up' }

  const { error } = await supabase.rpc('tracker_init_group', { p_group_id: groupId })
  if (error) return { state: 'error', message: error.message }
  return { state: 'ready' }
}

export type GroupPerson = { id: string; name: string; role: string }

/**
 * People of a group: { id, name, role }. Checks the caller is a member with
 * the server client first (RLS), then reads names with the admin client
 * (full_name, else display_name, else email) — the same approach the Members
 * API uses. Returns null when the caller is not a member of the group.
 */
export async function getGroupPeople(
  supabase: SupabaseClient,
  groupId: string,
): Promise<GroupPerson[] | null> {
  // Membership check through the server client (RLS-governed read): the caller
  // must have their own user_groups row in this group — the same check the
  // Members API uses. Only then do we read names with the admin client.
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return null

  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', groupId)
    .maybeSingle()

  if (!membership) return null

  const admin = createAdminClient()
  const { data: userGroups, error } = await admin
    .from('user_groups')
    .select('user_id, role')
    .eq('group_id', groupId)

  if (error) return []

  const people: GroupPerson[] = await Promise.all(
    (userGroups ?? []).map(async (ug: { user_id: string; role: string }) => {
      let name = ''
      try {
        const { data } = await admin.auth.admin.getUserById(ug.user_id)
        const meta = (data.user?.user_metadata ?? {}) as Record<string, unknown>
        const full = typeof meta.full_name === 'string' ? meta.full_name.trim() : ''
        const display = typeof meta.display_name === 'string' ? meta.display_name.trim() : ''
        name = full || display || data.user?.email || ''
      } catch {
        name = ''
      }
      return { id: ug.user_id, name, role: ug.role }
    }),
  )

  return people
}

/** A quick id→name map for "by {name}" labels. */
export function nameMap(people: GroupPerson[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of people) out[p.id] = p.name || '—'
  return out
}
