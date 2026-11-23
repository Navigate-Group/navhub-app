/**
 * Tracker import, server side (P4) — server-only.
 * ──────────────────────────────────────────────────────────────────────────
 * Shared by the preview and apply routes: reads the uploaded file from the
 * request, loads what the translator needs (the group's people, region
 * lookups and what is already imported) and runs the translation.
 *
 * Reads go through the signed-in user's server client, so RLS decides; the
 * only admin-client use is getGroupPeople's name lookup (P5), after its
 * membership check. Saving is done by tracker_import_apply (migration 084).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getGroupPeople, type TrackerContext } from '@/lib/tracker/server'
import {
  parseExport, translateExport,
  type ExistingPlan, type ImportContext, type ImportPayload, type ImportPerson, type ImportPreview,
} from '@/lib/tracker/import'

/** Largest file the import accepts. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024

export type ImportRequest = {
  fileName: string | null
  file: unknown
  owners: Record<string, string>
}

/** Read { file_name, file, owners } from the request body. */
export async function readImportRequest(request: Request): Promise<ImportRequest | { error: string; status: number }> {
  const raw = await request.text()
  if (raw.length > MAX_IMPORT_BYTES * 1.5) {
    return { error: 'The file is too large (5 MB at most).', status: 413 }
  }
  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw)
  } catch {
    return { error: 'Invalid JSON', status: 400 }
  }
  const owners: Record<string, string> = {}
  if (body.owners && typeof body.owners === 'object' && !Array.isArray(body.owners)) {
    for (const [k, v] of Object.entries(body.owners as Record<string, unknown>)) {
      if (typeof v === 'string' && v) owners[k] = v
    }
  }
  const fileName = typeof body.file_name === 'string' ? body.file_name.slice(0, 200) : null
  return { fileName, file: body.file, owners }
}

/** Read every row of a query in pages (PostgREST returns 1,000 rows at most). */
async function readAll<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = []
  const size = 1000
  for (let from = 0; ; from += size) {
    const { data, error } = await query(from, from + size - 1)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < size) return out
  }
}

async function loadExisting(supabase: SupabaseClient, groupId: string): Promise<ImportContext['existing']> {
  const plans = await readAll<{ legacy_id: string; owner_id: string; archived_at: string | null }>((a, b) =>
    supabase.from('tracker_project_plans').select('legacy_id, owner_id, archived_at')
      .eq('group_id', groupId).not('legacy_id', 'is', null).order('legacy_id').range(a, b))
  const ids = (table: string, kindUpdate = false) =>
    readAll<{ legacy_id: string }>((a, b) => {
      let q = supabase.from(table).select('legacy_id').eq('group_id', groupId).not('legacy_id', 'is', null)
      if (kindUpdate) q = q.eq('kind', 'update')
      return q.order('legacy_id').range(a, b)
    }).then((rows) => rows.map((r) => r.legacy_id))

  const [actions, contacts, updates] = await Promise.all([
    ids('tracker_actions'), ids('tracker_contacts'), ids('tracker_updates', true),
  ])
  const existingPlans: ExistingPlan[] = plans.map((p) => ({
    legacy_id: p.legacy_id, owner_id: p.owner_id, archived: p.archived_at !== null,
  }))
  return { plans: existingPlans, actions, contacts, updates }
}

export type PreparedImport =
  | { ok: true; payload: ImportPayload; preview: ImportPreview; editors: ImportPerson[] }
  | { ok: false; status: number; errors: string[] }

/** Parse and translate the file for the current group. */
export async function prepareImport(ctx: TrackerContext, req: ImportRequest): Promise<PreparedImport> {
  const parsed = parseExport(req.file)
  if (!parsed.ok) return { ok: false, status: 422, errors: parsed.errors }

  const { supabase, groupId, userId } = ctx
  const people = await getGroupPeople(supabase, groupId)
  if (!people) return { ok: false, status: 403, errors: ['You are not a member of this group.'] }

  const { data: regionRows, error: regionErr } = await supabase
    .from('tracker_lookups').select('key, label').eq('group_id', groupId).eq('list', 'region')
  if (regionErr) return { ok: false, status: 500, errors: [regionErr.message] }

  let existing: ImportContext['existing']
  try {
    existing = await loadExisting(supabase, groupId)
  } catch (e) {
    return { ok: false, status: 500, errors: [e instanceof Error ? e.message : 'Could not read the projects'] }
  }

  const { payload, preview } = translateExport(parsed.data, {
    importerId: userId,
    people,
    regions: (regionRows ?? []) as { key: string; label: string }[],
    existing,
    owners: req.owners,
  })
  const editors = people
    .filter((p) => p.role === 'manager' || p.role === 'group_owner')
    .sort((a, b) => a.name.localeCompare(b.name))
  return { ok: true, payload, preview, editors }
}
