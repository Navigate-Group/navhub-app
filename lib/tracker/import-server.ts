/**
 * Tracker import — server side (P4). server-only.
 * ──────────────────────────────────────────────────────────────────────────
 * Glue between the import wizard and the database. Two handlers:
 *
 *   • handlePreview(request) — read the uploaded file, gather the group's
 *     people + region lookups + known lookup keys + the legacy ids already in
 *     the group, translate, and return the preview plus the list of editors the
 *     wizard offers as owners. Saves NOTHING.
 *
 *   • handleApply(request)   — translate again (never trust the client's
 *     payload), refuse with 422 if the translator found problems, then call the
 *     database function tracker_import_apply(). On a database error, record a
 *     `failed` import job and return the error. On success, return the summary.
 *
 * Everything runs as the signed-in user through the Supabase server client, so
 * migration 082's RLS and 084's editor guard decide who may import — a non-
 * editor is refused by the database, not merely the UI. Reading the group's
 * people reuses getGroupPeople (server-client membership check, then names via
 * the admin client — the same approach the rest of the tracker uses).
 */

import { NextResponse } from 'next/server'
import { getTrackerContext, isEditor, getGroupPeople } from '@/lib/tracker/server'
import { writeErrorResponse } from '@/lib/tracker/api'
import {
  parseExport,
  translateExport,
  ImportParseError,
  type ImportContext,
  type ImportPerson,
  type OwnerChoice,
} from '@/lib/tracker/import'

const MAX_BYTES = 5 * 1024 * 1024 // 5 MB
const EDITOR_ROLES = ['manager', 'group_owner']

/** Read the uploaded file from a multipart form or a JSON body. */
async function readRaw(request: Request): Promise<{ raw: string; fileName: string } | NextResponse> {
  const contentType = request.headers.get('content-type') ?? ''

  if (contentType.includes('multipart/form-data')) {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return NextResponse.json({ error: 'The upload could not be read' }, { status: 400 })
    }
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Choose a file to import' }, { status: 422 })
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'The file is larger than 5 MB' }, { status: 413 })
    }
    const raw = await file.text()
    return { raw, fileName: file.name || 'import.json' }
  }

  // JSON fallback: { fileName, raw } (the wizard sends multipart; this keeps the
  // apply step simple when it re-sends the already-read text).
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const raw = typeof body.raw === 'string' ? body.raw : null
  if (!raw) return NextResponse.json({ error: 'Choose a file to import' }, { status: 422 })
  if (raw.length > MAX_BYTES) {
    return NextResponse.json({ error: 'The file is larger than 5 MB' }, { status: 413 })
  }
  const fileName = typeof body.fileName === 'string' && body.fileName ? body.fileName : 'import.json'
  return { raw, fileName }
}

/** Load the context the translator needs: people, regions, lookups, legacy ids. */
async function loadContext(
  ctx: NonNullable<Awaited<ReturnType<typeof getTrackerContext>>>,
): Promise<{ context: ImportContext; editors: ImportPerson[] } | NextResponse> {
  const { supabase, groupId } = ctx

  const people = (await getGroupPeople(supabase, groupId)) ?? []
  const importPeople: ImportPerson[] = people.map((p) => ({ id: p.id, name: p.name, role: p.role }))
  const editors = importPeople.filter((p) => EDITOR_ROLES.includes(p.role))

  // Lookup keys by list (regions carry labels too).
  const { data: lookupRows } = await supabase
    .from('tracker_lookups')
    .select('list, key, label')
    .eq('group_id', groupId)
    .eq('active', true)

  const byList: Record<string, { key: string; label: string }[]> = {}
  for (const r of (lookupRows ?? []) as { list: string; key: string; label: string }[]) {
    ;(byList[r.list] ??= []).push({ key: r.key, label: r.label })
  }
  const keysOf = (list: string) => (byList[list] ?? []).map((r) => r.key)

  // Legacy ids already present (so the preview splits new vs changed, and the
  // translator accepts parents/references that were imported earlier).
  const [plans, milestones, actions, contacts, updates] = await Promise.all([
    supabase.from('tracker_project_plans').select('legacy_id').eq('group_id', groupId).not('legacy_id', 'is', null),
    supabase.from('tracker_milestones').select('legacy_id').eq('group_id', groupId).not('legacy_id', 'is', null),
    supabase.from('tracker_actions').select('legacy_id').eq('group_id', groupId).not('legacy_id', 'is', null),
    supabase.from('tracker_contacts').select('legacy_id').eq('group_id', groupId).not('legacy_id', 'is', null),
    supabase.from('tracker_updates').select('legacy_id').eq('group_id', groupId).not('legacy_id', 'is', null),
  ])

  const ids = (res: { data: { legacy_id: string | null }[] | null }) =>
    (res.data ?? []).map((r) => r.legacy_id).filter((x): x is string => !!x)

  const context: ImportContext = {
    groupId,
    people: importPeople,
    regions: byList.region ?? [],
    lookups: {
      status: keysOf('status'),
      milestone_status: keysOf('milestone_status'),
      action_type: keysOf('action_type'),
      source: keysOf('source'),
      category: keysOf('category'),
    },
    existing: {
      plans: ids(plans),
      milestones: ids(milestones),
      actions: ids(actions),
      contacts: ids(contacts),
      updates: ids(updates),
    },
  }
  return { context, editors }
}

/** Parse the owner choices the client sends with an apply (old plan id → owner). */
function readOwnerChoices(v: unknown): OwnerChoice[] {
  if (!Array.isArray(v)) return []
  const out: OwnerChoice[] = []
  for (const c of v) {
    if (c && typeof c === 'object') {
      const legacyPlanId = (c as Record<string, unknown>).legacyPlanId
      const ownerId = (c as Record<string, unknown>).ownerId
      if (typeof legacyPlanId === 'string' && typeof ownerId === 'string') {
        out.push({ legacyPlanId, ownerId })
      }
    }
  }
  return out
}

// ── POST /api/tracker/import/preview ────────────────────────────────────────
export async function handlePreview(request: Request): Promise<NextResponse> {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!(await isEditor(ctx.supabase, ctx.groupId))) {
    return NextResponse.json({ error: "You don't have permission to import" }, { status: 403 })
  }

  const read = await readRaw(request)
  if (read instanceof NextResponse) return read

  const loaded = await loadContext(ctx)
  if (loaded instanceof NextResponse) return loaded

  // The preview resolves owners by name only; the user picks any unmatched
  // owners in the wizard, and those choices are sent on apply.
  let preview
  try {
    const file = parseExport(read.raw)
    preview = translateExport(file, loaded.context, [])
  } catch (e) {
    if (e instanceof ImportParseError) {
      return NextResponse.json({ error: e.message }, { status: 422 })
    }
    return NextResponse.json({ error: 'The file could not be read' }, { status: 422 })
  }

  return NextResponse.json({
    fileName: read.fileName,
    preview,
    editors: loaded.editors.map((e) => ({ id: e.id, name: e.name })),
  })
}

// ── POST /api/tracker/import/apply ──────────────────────────────────────────
export async function handleApply(request: Request): Promise<NextResponse> {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase, groupId } = ctx
  if (!(await isEditor(supabase, groupId))) {
    return NextResponse.json({ error: "You don't have permission to import" }, { status: 403 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const raw = typeof body.raw === 'string' ? body.raw : null
  if (!raw) return NextResponse.json({ error: 'The file is missing' }, { status: 422 })
  if (raw.length > MAX_BYTES) {
    return NextResponse.json({ error: 'The file is larger than 5 MB' }, { status: 413 })
  }
  const fileName = typeof body.fileName === 'string' && body.fileName ? body.fileName : 'import.json'
  const ownerChoices = readOwnerChoices(body.ownerChoices)

  const loaded = await loadContext(ctx)
  if (loaded instanceof NextResponse) return loaded

  // Translate AGAIN from the raw file + choices — never trust a client payload.
  let preview
  try {
    const file = parseExport(raw)
    preview = translateExport(file, loaded.context, ownerChoices)
  } catch (e) {
    if (e instanceof ImportParseError) {
      return NextResponse.json({ error: e.message }, { status: 422 })
    }
    return NextResponse.json({ error: 'The file could not be read' }, { status: 422 })
  }

  // Refuse while there are blocking problems — and save nothing.
  if (preview.problems.length > 0) {
    return NextResponse.json({ error: 'The import has problems', problems: preview.problems }, { status: 422 })
  }

  // Apply in one transaction via the database function (editor-guarded there too).
  const { data, error } = await supabase.rpc('tracker_import_apply', {
    p_group_id: groupId,
    p_file_name: fileName,
    p_payload: preview.payload,
  })

  if (error) {
    // Record a failed job so the attempt is visible, then surface the error.
    await supabase.from('tracker_import_jobs').insert({
      group_id: groupId,
      file_name: fileName,
      status: 'failed',
      summary: { error: error.message },
    })
    return writeErrorResponse(error)
  }

  return NextResponse.json({ summary: data }, { status: 200 })
}
