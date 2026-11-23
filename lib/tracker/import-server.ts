/**
 * Tracker import — shared server helpers (P4c), server-only.
 * ──────────────────────────────────────────────────────────────────────────
 * Used by both import routes. Reads and validates the request body, loads the
 * context the pure translator (lib/tracker/import.ts) needs, runs parse +
 * translate, and returns the payload, preview and the group's editors (for the
 * owner pickers). Nothing here writes to the database.
 *
 * Every read runs as the signed-in user through the Supabase server client, so
 * migration 082's access rules decide (the admin client is used only inside
 * getGroupPeople). Legacy-id lists are read in pages of 1,000 (PostgREST's
 * default cap) so large groups still load fully.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getGroupPeople, type GroupPerson } from '@/lib/tracker/server'
import {
  parseExport,
  translateExport,
  type ImportContext,
  type ImportPayload,
  type ImportPreview,
  type ExistingPlan,
} from '@/lib/tracker/import'

/** About 5 MB of JSON; the base64/transport overhead pushes the body a little
 * higher, so refuse bodies over ~7.5 MB with a 413. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024
export const MAX_BODY_BYTES = Math.round(7.5 * 1024 * 1024)

export type ImportRequestBody = {
  file_name: string | null
  file: unknown
  owners: Record<string, string>
}

export type ImportEditor = { id: string; name: string }

export type PrepareResult =
  | { ok: true; payload: ImportPayload; preview: ImportPreview; editors: ImportEditor[] }
  | { ok: false; status: number; error: string; problems?: string[] }

const PAGE = 1000

/**
 * Read and validate the JSON body. Refuses bodies over ~7.5 MB with 413 and
 * invalid JSON with 400. `file` is the parsed export JSON; `owners` maps an old
 * project id → chosen owner user id.
 */
export async function readImportBody(
  request: Request,
): Promise<{ ok: true; body: ImportRequestBody } | { ok: false; status: number; error: string }> {
  const text = await request.text()
  // Byte length (not code-unit length) for the size guard.
  const bytes = new TextEncoder().encode(text).length
  if (bytes > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'The file is too large. The limit is 5 MB.' }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, status: 400, error: 'The request body is not valid JSON.' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, status: 400, error: 'The request body is not valid JSON.' }
  }

  const obj = raw as Record<string, unknown>
  const fileName = typeof obj.file_name === 'string' ? obj.file_name : null

  const owners: Record<string, string> = {}
  if (obj.owners && typeof obj.owners === 'object' && !Array.isArray(obj.owners)) {
    for (const [k, val] of Object.entries(obj.owners as Record<string, unknown>)) {
      if (typeof val === 'string' && val !== '') owners[k] = val
    }
  }

  return { ok: true, body: { file_name: fileName, file: obj.file, owners } }
}

/** Read every row with a non-null legacy_id, a page (1,000) at a time. */
async function loadLegacyIds(
  supabase: SupabaseClient,
  table: string,
  select: string,
  groupId: string,
  extraKind?: string,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  for (let from = 0; ; from += PAGE) {
    let query = supabase
      .from(table)
      .select(select)
      .eq('group_id', groupId)
      .not('legacy_id', 'is', null)
      .order('legacy_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (extraKind) query = query.eq('kind', extraKind)
    const { data, error } = await query
    if (error || !data) break
    rows.push(...(data as unknown as Record<string, unknown>[]))
    if (data.length < PAGE) break
  }
  return rows
}

/**
 * Load the translator context and build the preview + payload for a parsed
 * export. `importerId` is the signed-in user (default owner/author). Returns a
 * 422 with the parse problems when the file isn't an export of the old tracker.
 */
export async function prepareImport(
  supabase: SupabaseClient,
  userId: string,
  groupId: string,
  body: ImportRequestBody,
): Promise<PrepareResult> {
  const parsed = parseExport(body.file)
  if (!parsed.ok) {
    return { ok: false, status: 422, error: 'This is not an export from the previous tracker.', problems: parsed.errors }
  }

  // People (names + roles) and the group's region lookups.
  const people: GroupPerson[] = (await getGroupPeople(supabase, groupId)) ?? []

  const { data: regionRows } = await supabase
    .from('tracker_lookups')
    .select('key, label')
    .eq('group_id', groupId)
    .eq('list', 'region')
  const regions = (regionRows ?? []).map((r) => ({ key: r.key as string, label: r.label as string }))

  // Legacy ids already imported (so re-import counts as "existing").
  const planRows = await loadLegacyIds(
    supabase,
    'tracker_project_plans',
    'legacy_id, owner_id, archived_at',
    groupId,
  )
  const existingPlans: ExistingPlan[] = planRows.map((p) => ({
    legacy_id: p.legacy_id as string,
    owner_id: (p.owner_id as string) ?? '',
    archived: p.archived_at !== null,
  }))

  const actionRows = await loadLegacyIds(supabase, 'tracker_actions', 'legacy_id', groupId)
  const contactRows = await loadLegacyIds(supabase, 'tracker_contacts', 'legacy_id', groupId)
  const updateRows = await loadLegacyIds(supabase, 'tracker_updates', 'legacy_id', groupId, 'update')

  const context: ImportContext = {
    importerId: userId,
    people: people.map((p) => ({ id: p.id, name: p.name, role: p.role })),
    regions,
    existing: {
      plans: existingPlans,
      actions: actionRows.map((r) => r.legacy_id as string),
      contacts: contactRows.map((r) => r.legacy_id as string),
      updates: updateRows.map((r) => r.legacy_id as string),
    },
    owners: body.owners,
  }

  const { payload, preview } = translateExport(parsed.data, context)

  // Editors (Managers and Group Owners) for the owner pickers, sorted by name.
  const editors: ImportEditor[] = people
    .filter((p) => p.role === 'manager' || p.role === 'group_owner')
    .map((p) => ({ id: p.id, name: p.name || '—' }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return { ok: true, payload, preview, editors }
}
