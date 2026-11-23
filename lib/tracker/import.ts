/**
 * Tracker import translator (P4) — pure, client-safe.
 * ──────────────────────────────────────────────────────────────────────────
 * Turns the PREVIOUS tracker's export file (JSON) into the NavHub shape the
 * database understands, and into a preview for the user. This module has NO
 * imports: it is pure TypeScript that runs equally on the server (preview /
 * apply route handlers) and in the browser (the wizard shows the same preview).
 *
 * It does two things:
 *   • parseExport(raw)       — parse + validate the JSON structure.
 *   • translateExport(file,  — map the old tracker's values onto NavHub keys,
 *     context)                 resolve owners / assignees / contacts by name,
 *                              build the plan tree, and emit a preview with:
 *                                - counts split new / changed / unchanged
 *                                - a row per project (with an owner picker)
 *                                - problems that block the import
 *                                - notes to show the user
 *                              plus a `payload` the apply step hands to the
 *                              database function tracker_import_apply().
 *
 * Records are matched to existing rows on the OLD tracker's ids (`legacy_id`),
 * so re-importing the same file updates what changed instead of duplicating.
 * The import only ADDS and UPDATES — it never deletes anything.
 *
 * The database (migration 084 + the RLS from 082) is the real guard; this
 * translator only shapes and previews. Anything it flags as a problem the
 * apply route refuses with a 422 before touching the database.
 */

// ── The old tracker's export shape ──────────────────────────────────────────
// A deliberately small, documented contract. The old tracker exported one JSON
// object: a header plus arrays of plans, milestones, actions, contacts,
// contact→plan links and plan updates/reviews. Every record carries the old
// tracker's own id in `id` (we keep it as `legacy_id`). Dates are 'YYYY-MM-DD'.

export type LegacyExport = {
  /** Export format marker. We accept 'tracker-export' at version 1. */
  format?: string
  version?: number
  /** The old tracker's name for the export, shown as a note. */
  exported_at?: string
  plans?: LegacyPlan[]
  milestones?: LegacyMilestone[]
  actions?: LegacyAction[]
  contacts?: LegacyContact[]
  /** contact id → plan id links (contacts attached to projects). */
  contact_links?: LegacyContactLink[]
  /** dated narrative updates / handovers on a plan. */
  updates?: LegacyUpdate[]
}

export type LegacyPlan = {
  id: string
  name: string
  /** old status code, e.g. 'G'/'A'/'R' or 'green'/'amber'; mapped below. */
  status?: string | null
  category?: string | null
  client?: string | null
  phase?: string | null
  summary?: string | null
  folder?: string | null
  /** free-text region name, e.g. "Western Australia"; mapped to a key. */
  region?: string | null
  /** old id of the parent plan (sub-project), if any. */
  parent_id?: string | null
  /** owner's DISPLAY NAME in the old tracker; matched to a NavHub person. */
  owner?: string | null
  /** lead's display name; matched to a NavHub member (optional). */
  lead?: string | null
  start_on?: string | null
  end_on?: string | null
  /** old priority: 'high'/'normal' or 1/0; anything truthy-high → 'high'. */
  priority?: string | number | null
  progress_pct?: number | null
  /** the old tracker's last-updated date; preserved so we don't re-stamp. */
  updated_on?: string | null
  /** truthy = the project was archived in the old tracker. */
  archived?: boolean | null
}

export type LegacyMilestone = {
  id: string
  plan_id: string
  title: string
  description?: string | null
  /** old milestone status; mapped to a NavHub milestone_status key. */
  status?: string | null
  owner?: string | null
  start_on?: string | null
  due_on?: string | null
  completed_on?: string | null
  progress_pct?: number | null
  priority?: string | number | null
}

export type LegacyAction = {
  id: string
  plan_id?: string | null
  milestone_id?: string | null
  title: string
  /** old action type, e.g. 'TODO'/'CALL'; mapped to a NavHub action_type. */
  type?: string | null
  /** free-text 'who', kept as-is for display. */
  who?: string | null
  /** assignee display name; matched to a NavHub member. */
  assignee?: string | null
  /** contact id (old) this action is about, if any. */
  contact_id?: string | null
  due_on?: string | null
  /** old action status; mapped to open | waiting | done. */
  status?: string | null
  priority?: string | number | null
  notes?: string | null
  waiting_since?: string | null
  done_on?: string | null
}

export type LegacyContact = {
  id: string
  name: string
  org?: string | null
  role?: string | null
  phone?: string | null
  email?: string | null
  notes?: string | null
  last_contact?: string | null
  owner?: string | null
}

export type LegacyContactLink = { contact_id: string; plan_id: string }

export type LegacyUpdate = {
  id: string
  plan_id: string
  /** 'update' | 'handover'; anything else falls back to 'update'. */
  kind?: string | null
  date?: string | null
  /** old source code; mapped to a NavHub source key when known. */
  source?: string | null
  text: string
}

// ── The translation context the server supplies ─────────────────────────────

export type ImportPerson = { id: string; name: string; role: string }

export type ImportContext = {
  /** The group the import targets. */
  groupId: string
  /** The group's people (id, display name, role) for name matching. */
  people: ImportPerson[]
  /** Existing region lookups (key + label) so we reuse before adding. */
  regions: { key: string; label: string }[]
  /** Known NavHub lookup keys per list, so we only emit valid keys. */
  lookups: {
    status: string[]
    milestone_status: string[]
    action_type: string[]
    source: string[]
    category: string[]
  }
  /**
   * Legacy ids already present in the group, per entity, so we can split the
   * preview into new / changed / unchanged. Keyed by the old id.
   */
  existing: {
    plans: string[]
    milestones: string[]
    actions: string[]
    contacts: string[]
    updates: string[]
  }
}

// ── The payload handed to tracker_import_apply() ────────────────────────────
// Plain JSON, NavHub keys, ids matched on legacy_id. The database function does
// the upserts in one transaction.

export type ApplyPlan = {
  legacy_id: string
  name: string
  status: string | null
  category: string | null
  client: string | null
  phase: string | null
  summary: string | null
  folder: string | null
  region: string | null
  parent_legacy_id: string | null
  owner_id: string
  lead_id: string | null
  start_on: string | null
  end_on: string | null
  priority: 'normal' | 'high'
  progress_pct: number
  updated_on: string | null
  archived: boolean
}

export type ApplyMilestone = {
  legacy_id: string
  plan_legacy_id: string
  title: string
  /** sha-ish hash of the title, used to spot the same milestone across files. */
  title_hash: string
  description: string | null
  status: string
  owner_id: string | null
  start_on: string | null
  due_on: string | null
  completed_on: string | null
  progress_pct: number
  priority: 'normal' | 'high'
}

export type ApplyAction = {
  legacy_id: string
  plan_legacy_id: string | null
  milestone_legacy_id: string | null
  title: string
  type: string | null
  who: string | null
  assignee_id: string | null
  contact_legacy_id: string | null
  due_on: string | null
  status: 'open' | 'waiting' | 'done'
  priority: 'normal' | 'high'
  notes: string | null
  waiting_since: string | null
  done_on: string | null
}

export type ApplyContact = {
  legacy_id: string
  name: string
  org: string | null
  role: string | null
  phone: string | null
  email: string | null
  notes: string | null
  last_contact: string | null
  owner_id: string | null
}

export type ApplyContactLink = { contact_legacy_id: string; plan_legacy_id: string }

export type ApplyUpdate = {
  legacy_id: string
  plan_legacy_id: string
  kind: 'update' | 'handover'
  date: string | null
  source: string | null
  text: string
}

export type ApplyRegion = { key: string; label: string }

export type ApplyPayload = {
  regions: ApplyRegion[]
  plans: ApplyPlan[]
  milestones: ApplyMilestone[]
  actions: ApplyAction[]
  contacts: ApplyContact[]
  contact_links: ApplyContactLink[]
  updates: ApplyUpdate[]
}

// ── The preview the screen shows ────────────────────────────────────────────

export type PreviewCounts = { new: number; changed: number; unchanged: number }

export type PreviewProjectRow = {
  legacy_id: string
  name: string
  /** 'new' | 'changed' | 'unchanged' against the existing legacy ids. */
  state: 'new' | 'changed' | 'unchanged'
  /** the owner name as written in the old file (for display). */
  ownerName: string | null
  /** the resolved NavHub owner id, or null when it must be chosen. */
  ownerId: string | null
  /** true when the owner could not be matched and the user must choose. */
  ownerNeedsChoice: boolean
  milestones: number
  actions: number
}

export type ImportPreview = {
  counts: {
    plans: PreviewCounts
    milestones: PreviewCounts
    actions: PreviewCounts
    contacts: PreviewCounts
    updates: PreviewCounts
  }
  projects: PreviewProjectRow[]
  /** regions that will be added to tracker_lookups. */
  newRegions: ApplyRegion[]
  /** problems that BLOCK the import (apply refuses while any remain). */
  problems: string[]
  /** notes to show the user (not blocking). */
  notes: string[]
  /** the payload the apply step hands to the database. */
  payload: ApplyPayload
}

/** A choice the user made in the wizard: an old plan id → a NavHub owner id. */
export type OwnerChoice = { legacyPlanId: string; ownerId: string }

// ── parseExport ─────────────────────────────────────────────────────────────

export class ImportParseError extends Error {}

/**
 * Parse + validate the raw JSON string. Throws ImportParseError with a plain
 * message on anything malformed. On success returns a normalised LegacyExport
 * with every array present (empty when absent).
 */
export function parseExport(raw: string): LegacyExport {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    throw new ImportParseError('The file is not valid JSON.')
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ImportParseError('The file must be a single JSON object.')
  }
  const o = obj as Record<string, unknown>

  if (o.format !== undefined && o.format !== 'tracker-export') {
    throw new ImportParseError(
      `Unrecognised export format "${String(o.format)}". Expected "tracker-export".`,
    )
  }
  if (o.version !== undefined && o.version !== 1) {
    throw new ImportParseError(
      `Unsupported export version ${String(o.version)}. This importer handles version 1.`,
    )
  }

  const plans = asArray(o.plans, 'plans')
  const milestones = asArray(o.milestones, 'milestones')
  const actions = asArray(o.actions, 'actions')
  const contacts = asArray(o.contacts, 'contacts')
  const contactLinks = asArray(o.contact_links, 'contact_links')
  const updates = asArray(o.updates, 'updates')

  // Every record needs a non-empty string id (so matching on legacy_id works).
  requireIds(plans, 'plan')
  requireIds(milestones, 'milestone')
  requireIds(actions, 'action')
  requireIds(contacts, 'contact')
  requireIds(updates, 'update')

  // Plans and contacts need a name/title; milestones/updates/actions a title.
  for (const p of plans) requireText(p, 'name', 'plan')
  for (const m of milestones) requireText(m, 'title', 'milestone')
  for (const a of actions) requireText(a, 'title', 'action')
  for (const c of contacts) requireText(c, 'name', 'contact')
  for (const u of updates) requireText(u, 'text', 'update')

  // Dates must parse when present (bad dates caught here, not at the database).
  for (const p of plans)
    checkDates(p, ['start_on', 'end_on', 'updated_on'], `plan "${String((p as LegacyPlan).name)}"`)
  for (const m of milestones)
    checkDates(m, ['start_on', 'due_on', 'completed_on'], `milestone "${String((m as LegacyMilestone).title)}"`)
  for (const a of actions)
    checkDates(a, ['due_on', 'waiting_since', 'done_on'], `action "${String((a as LegacyAction).title)}"`)
  for (const c of contacts) checkDates(c, ['last_contact'], `contact "${String((c as LegacyContact).name)}"`)
  for (const u of updates) checkDates(u, ['date'], 'an update')

  return {
    format: 'tracker-export',
    version: 1,
    exported_at: typeof o.exported_at === 'string' ? o.exported_at : undefined,
    plans: plans as LegacyPlan[],
    milestones: milestones as LegacyMilestone[],
    actions: actions as LegacyAction[],
    contacts: contacts as LegacyContact[],
    contact_links: contactLinks as LegacyContactLink[],
    updates: updates as LegacyUpdate[],
  }
}

function asArray(v: unknown, field: string): Record<string, unknown>[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new ImportParseError(`"${field}" must be a list.`)
  for (const item of v) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ImportParseError(`Every item in "${field}" must be an object.`)
    }
  }
  return v as Record<string, unknown>[]
}

function requireIds(rows: Record<string, unknown>[], label: string): void {
  const seen = new Set<string>()
  for (const r of rows) {
    const id = r.id
    if (typeof id !== 'string' || id.trim() === '') {
      throw new ImportParseError(`Every ${label} needs an id.`)
    }
    if (seen.has(id)) throw new ImportParseError(`Two ${label}s share the id "${id}".`)
    seen.add(id)
  }
}

function requireText(r: Record<string, unknown>, field: string, label: string): void {
  const v = r[field]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ImportParseError(`A ${label} (id "${String(r.id)}") is missing its ${field}.`)
  }
}

function checkDates(r: Record<string, unknown>, fields: string[], where: string): void {
  for (const f of fields) {
    const v = r[f]
    if (v === undefined || v === null || v === '') continue
    if (typeof v !== 'string' || !isIsoDate(v)) {
      throw new ImportParseError(`${where} has a bad ${f} date: "${String(v)}".`)
    }
  }
}

/** True for a real 'YYYY-MM-DD' calendar date. */
export function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const [, y, mo, d] = m.map(Number)
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

// ── Value maps (old tracker → NavHub keys) ──────────────────────────────────
// Only the keys NavHub actually has (migration 081/082 seeds) are valid; an old
// value that maps to nothing becomes null (a note is raised so the user knows).

const STATUS_MAP: Record<string, string> = {
  // old RAG / code → NavHub status keys
  g: 'on_track',
  green: 'on_track',
  on_track: 'on_track',
  ontrack: 'on_track',
  a: 'at_risk',
  amber: 'at_risk',
  at_risk: 'at_risk',
  atrisk: 'at_risk',
  r: 'blocked',
  red: 'blocked',
  blocked: 'blocked',
  waiting: 'waiting_on_others',
  waiting_on_others: 'waiting_on_others',
  proposal: 'proposal_pre_contract',
  pre_contract: 'proposal_pre_contract',
  proposal_pre_contract: 'proposal_pre_contract',
  wrapping_up: 'wrapping_up',
  wrapup: 'wrapping_up',
  needs_status: 'needs_status_check',
  needs_status_check: 'needs_status_check',
  done: 'finished',
  complete: 'finished',
  completed: 'finished',
  finished: 'finished',
}

const MILESTONE_STATUS_MAP: Record<string, string> = {
  backlog: 'backlog',
  todo: 'backlog',
  planned: 'planned',
  plan: 'planned',
  in_progress: 'in_progress',
  inprogress: 'in_progress',
  doing: 'in_progress',
  active: 'in_progress',
  at_risk: 'at_risk',
  atrisk: 'at_risk',
  blocked: 'blocked',
  stuck: 'blocked',
  done: 'completed',
  complete: 'completed',
  completed: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
}

const ACTION_TYPE_MAP: Record<string, string> = {
  todo: 'do',
  task: 'do',
  do: 'do',
  action: 'do',
  call: 'call',
  phone: 'call',
  email: 'email',
  mail: 'email',
  chase: 'chase',
  followup: 'chase',
  follow_up: 'chase',
  decide: 'decide',
  decision: 'decide',
  meeting: 'meeting',
  meet: 'meeting',
}

const ACTION_STATUS_MAP: Record<string, 'open' | 'waiting' | 'done'> = {
  open: 'open',
  todo: 'open',
  active: 'open',
  waiting: 'waiting',
  blocked: 'waiting',
  pending: 'waiting',
  done: 'done',
  complete: 'done',
  completed: 'done',
  closed: 'done',
}

const SOURCE_MAP: Record<string, string> = {
  note: 'my_note',
  my_note: 'my_note',
  manual: 'my_note',
  email: 'email',
  screenshot: 'screenshot',
  meeting: 'meeting',
  file: 'file_folder',
  folder: 'file_folder',
  file_folder: 'file_folder',
  call: 'call',
  phone: 'call',
}

const UPDATE_KIND_MAP: Record<string, 'update' | 'handover'> = {
  update: 'update',
  note: 'update',
  handover: 'handover',
  handoff: 'handover',
}

function norm(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  return String(v).trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function mapWith(
  map: Record<string, string>,
  raw: string | number | null | undefined,
): string | null {
  const k = norm(raw)
  if (k === '') return null
  return map[k] ?? null
}

/** 'high' when the old priority reads high/urgent/1/true; else 'normal'. */
function mapPriority(raw: string | number | null | undefined): 'normal' | 'high' {
  if (raw === null || raw === undefined) return 'normal'
  if (typeof raw === 'number') return raw > 0 ? 'high' : 'normal'
  const k = norm(raw)
  return k === 'high' || k === 'urgent' || k === '1' || k === 'true' ? 'high' : 'normal'
}

function clampPct(v: number | null | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.max(0, Math.min(100, Math.round(v)))
}

// ── Region + name resolution ────────────────────────────────────────────────

/** A stable lookup key from a free-text region name: lower, words joined by _. */
export function regionKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}

/**
 * A short, stable hash of a milestone title (so the same milestone can be
 * spotted across files even if its old id changed). Dependency-free FNV-1a.
 */
export function titleHash(title: string): string {
  let h = 0x811c9dc5
  const s = title.trim().toLowerCase().replace(/\s+/g, ' ')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Normalise a person name for matching: trimmed, lower, single spaces. */
function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

function buildNameIndex(people: ImportPerson[]): Map<string, string[]> {
  const idx = new Map<string, string[]>()
  for (const p of people) {
    if (!p.name) continue
    const k = nameKey(p.name)
    ;(idx.get(k) ?? idx.set(k, []).get(k)!).push(p.id)
  }
  return idx
}

/**
 * Resolve a display name to exactly one NavHub person id, or null when there is
 * no match OR the match is ambiguous (two people share the name).
 */
function resolvePerson(name: string | null | undefined, idx: Map<string, string[]>): string | null {
  if (!name || name.trim() === '') return null
  const matches = idx.get(nameKey(name))
  if (!matches || matches.length !== 1) return null
  return matches[0]
}

// ── translateExport ─────────────────────────────────────────────────────────

/**
 * Translate a parsed export against the group context + any owner choices the
 * user made, producing the preview AND the apply payload. Pure: given the same
 * inputs it always returns the same result.
 *
 * Owner resolution order per plan: an explicit choice → the name match → null
 * (which becomes a blocking problem until the user picks one in the wizard).
 */
export function translateExport(
  file: LegacyExport,
  context: ImportContext,
  ownerChoices: OwnerChoice[] = [],
): ImportPreview {
  const problems: string[] = []
  const notes: string[] = []

  const nameIdx = buildNameIndex(context.people)
  const personIds = new Set(context.people.map((p) => p.id))
  const choiceByPlan = new Map(ownerChoices.map((c) => [c.legacyPlanId, c.ownerId]))
  const editors = new Set(
    context.people.filter((p) => p.role === 'manager' || p.role === 'group_owner').map((p) => p.id),
  )

  const plans = file.plans ?? []
  const milestones = file.milestones ?? []
  const actions = file.actions ?? []
  const contacts = file.contacts ?? []
  const contactLinks = file.contact_links ?? []
  const updates = file.updates ?? []

  const planIds = new Set(plans.map((p) => p.id))
  const milestoneIds = new Set(milestones.map((m) => m.id))
  const contactIds = new Set(contacts.map((c) => c.id))

  // ── Regions: reuse existing, add the rest ─────────────────────────────────
  const existingRegionKeys = new Set(context.regions.map((r) => r.key))
  const newRegionsByKey = new Map<string, ApplyRegion>()
  const planRegionKey = new Map<string, string | null>()
  for (const p of plans) {
    const label = (p.region ?? '').trim()
    if (label === '') {
      planRegionKey.set(p.id, null)
      continue
    }
    const key = regionKey(label)
    planRegionKey.set(p.id, key || null)
    if (key && !existingRegionKeys.has(key) && !newRegionsByKey.has(key)) {
      newRegionsByKey.set(key, { key, label })
    }
  }
  const newRegions = Array.from(newRegionsByKey.values())

  // ── Known-key helper (raise a note when an old value maps to nothing) ──────
  const statusKnown = new Set(context.lookups.status)
  const msStatusKnown = new Set(context.lookups.milestone_status)
  const actionTypeKnown = new Set(context.lookups.action_type)
  const sourceKnown = new Set(context.lookups.source)
  const categoryKnown = new Set(context.lookups.category)
  const unmappedNotes = new Set<string>()

  function mapChecked(
    map: Record<string, string>,
    known: Set<string>,
    raw: string | number | null | undefined,
    kind: string,
  ): string | null {
    if (raw === null || raw === undefined || String(raw).trim() === '') return null
    const mapped = mapWith(map, raw)
    if (mapped && known.has(mapped)) return mapped
    unmappedNotes.add(`${kind} value "${String(raw)}" wasn't recognised and was left blank.`)
    return null
  }

  // ── Plans ─────────────────────────────────────────────────────────────────
  const applyPlans: ApplyPlan[] = []
  const projects: PreviewProjectRow[] = []
  const existingPlans = new Set(context.existing.plans)

  // parent integrity: parent must be in this file (or already imported) and no loops.
  for (const p of plans) {
    const parent = (p.parent_id ?? '').trim()
    if (parent !== '' && !planIds.has(parent) && !existingPlans.has(parent)) {
      problems.push(`Project "${p.name}" points at a parent (${parent}) that isn't in this file.`)
    }
    if (parent !== '' && parent === p.id) {
      problems.push(`Project "${p.name}" is set as its own parent.`)
    }
  }
  detectPlanCycles(plans, problems)

  const msByPlan = countBy(milestones, (m) => m.plan_id)
  const actionsByPlan = countBy(actions, (a) => a.plan_id ?? '')

  for (const p of plans) {
    // Owner: an explicit choice wins, else the name match.
    const choice = choiceByPlan.get(p.id)
    let ownerId: string | null = null
    if (choice && personIds.has(choice)) ownerId = choice
    else ownerId = resolvePerson(p.owner, nameIdx)

    const ownerNeedsChoice = ownerId === null
    if (ownerId === null) {
      problems.push(`Choose an owner for project "${p.name}".`)
    } else if (!editors.has(ownerId)) {
      // The database rejects a non-editor owner; flag it before apply.
      problems.push(
        `The owner chosen for "${p.name}" must be a Manager or Group Owner of this group.`,
      )
    }

    const lead = resolvePerson(p.lead, nameIdx)
    if ((p.lead ?? '').trim() !== '' && lead === null) {
      notes.push(`Couldn't match the lead "${p.lead}" on "${p.name}"; left unset.`)
    }

    const category = p.category && categoryKnown.has(norm(p.category)) ? norm(p.category) : null
    if ((p.category ?? '').trim() !== '' && category === null) {
      unmappedNotes.add(`Category "${String(p.category)}" wasn't recognised and was left blank.`)
    }

    applyPlans.push({
      legacy_id: p.id,
      name: p.name.trim(),
      status: mapChecked(STATUS_MAP, statusKnown, p.status, 'Status'),
      category,
      client: strOrNull(p.client),
      phase: strOrNull(p.phase),
      summary: strOrNull(p.summary),
      folder: strOrNull(p.folder),
      region: planRegionKey.get(p.id) ?? null,
      parent_legacy_id: (p.parent_id ?? '').trim() || null,
      owner_id: ownerId ?? '',
      lead_id: lead,
      start_on: strOrNull(p.start_on),
      end_on: strOrNull(p.end_on),
      priority: mapPriority(p.priority),
      progress_pct: clampPct(p.progress_pct),
      updated_on: strOrNull(p.updated_on),
      archived: Boolean(p.archived),
    })

    projects.push({
      legacy_id: p.id,
      name: p.name.trim(),
      state: existingPlans.has(p.id) ? 'changed' : 'new',
      ownerName: strOrNull(p.owner),
      ownerId,
      ownerNeedsChoice,
      milestones: msByPlan.get(p.id) ?? 0,
      actions: actionsByPlan.get(p.id) ?? 0,
    })
  }

  // ── Milestones ────────────────────────────────────────────────────────────
  const applyMilestones: ApplyMilestone[] = []
  for (const m of milestones) {
    if (!planIds.has(m.plan_id) && !existingPlans.has(m.plan_id)) {
      problems.push(`Milestone "${m.title}" points at a project (${m.plan_id}) not in this file.`)
    }
    const status = mapChecked(MILESTONE_STATUS_MAP, msStatusKnown, m.status, 'Milestone status') ?? 'backlog'
    applyMilestones.push({
      legacy_id: m.id,
      plan_legacy_id: m.plan_id,
      title: m.title.trim(),
      title_hash: titleHash(m.title),
      description: strOrNull(m.description),
      status,
      owner_id: resolvePerson(m.owner, nameIdx),
      start_on: strOrNull(m.start_on),
      due_on: strOrNull(m.due_on),
      completed_on: strOrNull(m.completed_on),
      progress_pct: clampPct(m.progress_pct),
      priority: mapPriority(m.priority),
    })
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  const applyActions: ApplyAction[] = []
  for (const a of actions) {
    const plan = (a.plan_id ?? '').trim()
    if (plan !== '' && !planIds.has(plan) && !existingPlans.has(plan)) {
      problems.push(`Action "${a.title}" points at a project (${plan}) not in this file.`)
    }
    const ms = (a.milestone_id ?? '').trim()
    if (ms !== '' && !milestoneIds.has(ms) && !context.existing.milestones.includes(ms)) {
      problems.push(`Action "${a.title}" points at a milestone (${ms}) not in this file.`)
    }
    const contact = (a.contact_id ?? '').trim()
    if (contact !== '' && !contactIds.has(contact) && !context.existing.contacts.includes(contact)) {
      notes.push(`Action "${a.title}" references a contact (${contact}) not in this file; left unset.`)
    }
    applyActions.push({
      legacy_id: a.id,
      plan_legacy_id: plan || null,
      milestone_legacy_id: ms || null,
      title: a.title.trim(),
      type: mapChecked(ACTION_TYPE_MAP, actionTypeKnown, a.type, 'Action type'),
      who: strOrNull(a.who),
      assignee_id: resolvePerson(a.assignee, nameIdx),
      contact_legacy_id:
        contact !== '' && (contactIds.has(contact) || context.existing.contacts.includes(contact))
          ? contact
          : null,
      due_on: strOrNull(a.due_on),
      status: (mapWith(ACTION_STATUS_MAP, a.status) as 'open' | 'waiting' | 'done' | null) ?? 'open',
      priority: mapPriority(a.priority),
      notes: strOrNull(a.notes),
      waiting_since: strOrNull(a.waiting_since),
      done_on: strOrNull(a.done_on),
    })
  }

  // ── Contacts ──────────────────────────────────────────────────────────────
  const applyContacts: ApplyContact[] = contacts.map((c) => ({
    legacy_id: c.id,
    name: c.name.trim(),
    org: strOrNull(c.org),
    role: strOrNull(c.role),
    phone: strOrNull(c.phone),
    email: strOrNull(c.email),
    notes: strOrNull(c.notes),
    last_contact: strOrNull(c.last_contact),
    owner_id: resolvePerson(c.owner, nameIdx),
  }))

  // ── Contact links ─────────────────────────────────────────────────────────
  const applyLinks: ApplyContactLink[] = []
  for (const l of contactLinks) {
    const okContact = contactIds.has(l.contact_id) || context.existing.contacts.includes(l.contact_id)
    const okPlan = planIds.has(l.plan_id) || existingPlans.has(l.plan_id)
    if (!okContact || !okPlan) {
      notes.push(`A contact link (${l.contact_id} → ${l.plan_id}) couldn't be matched and was skipped.`)
      continue
    }
    applyLinks.push({ contact_legacy_id: l.contact_id, plan_legacy_id: l.plan_id })
  }

  // ── Updates / reviews ─────────────────────────────────────────────────────
  const applyUpdates: ApplyUpdate[] = []
  for (const u of updates) {
    if (!planIds.has(u.plan_id) && !existingPlans.has(u.plan_id)) {
      problems.push(`An update points at a project (${u.plan_id}) not in this file.`)
      continue
    }
    applyUpdates.push({
      legacy_id: u.id,
      plan_legacy_id: u.plan_id,
      kind: UPDATE_KIND_MAP[norm(u.kind)] ?? 'update',
      date: strOrNull(u.date),
      source: mapChecked(SOURCE_MAP, sourceKnown, u.source, 'Update source'),
      text: u.text.trim(),
    })
  }

  for (const n of Array.from(unmappedNotes)) notes.push(n)
  if (newRegions.length > 0) {
    notes.push(
      `${newRegions.length} new region${newRegions.length === 1 ? '' : 's'} will be added: ` +
        newRegions.map((r) => r.label).join(', ') + '.',
    )
  }

  const payload: ApplyPayload = {
    regions: newRegions,
    plans: applyPlans,
    milestones: applyMilestones,
    actions: applyActions,
    contacts: applyContacts,
    contact_links: applyLinks,
    updates: applyUpdates,
  }

  const preview: ImportPreview = {
    counts: {
      plans: splitCounts(plans, (p) => p.id, context.existing.plans),
      milestones: splitCounts(milestones, (m) => m.id, context.existing.milestones),
      actions: splitCounts(actions, (a) => a.id, context.existing.actions),
      contacts: splitCounts(contacts, (c) => c.id, context.existing.contacts),
      updates: splitCounts(updates, (u) => u.id, context.existing.updates),
    },
    projects,
    newRegions,
    problems: dedupe(problems),
    notes: dedupe(notes),
    payload,
  }
  return preview
}

// ── small helpers ───────────────────────────────────────────────────────────

function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs))
}

function countBy<T>(rows: T[], key: (r: T) => string): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) {
    const k = key(r)
    if (k === '') continue
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return m
}

/**
 * Split a set of records into new / changed / unchanged by legacy id. A record
 * whose id already exists is "changed" (the apply upsert decides if anything
 * really moved); everything brand new is "new". Nothing is counted "unchanged"
 * here because we match on id only — but the field is kept so the UI can show a
 * stable shape, and re-imports where all ids exist read as all-changed.
 */
function splitCounts<T>(rows: T[], key: (r: T) => string, existing: string[]): PreviewCounts {
  const have = new Set(existing)
  let isNew = 0
  let changed = 0
  for (const r of rows) {
    if (have.has(key(r))) changed++
    else isNew++
  }
  return { new: isNew, changed, unchanged: 0 }
}

/**
 * Walk the in-file parent chain for every plan and flag any loop as a problem.
 * Only considers parents present in THIS file (an out-of-file parent is caught
 * separately); a chain longer than the plan count must contain a cycle.
 */
function detectPlanCycles(plans: LegacyPlan[], problems: string[]): void {
  const parent = new Map<string, string>()
  const ids = new Set(plans.map((p) => p.id))
  for (const p of plans) {
    const par = (p.parent_id ?? '').trim()
    if (par !== '' && ids.has(par) && par !== p.id) parent.set(p.id, par)
  }
  for (const p of plans) {
    const seen = new Set<string>([p.id])
    let cur = parent.get(p.id)
    let steps = 0
    while (cur !== undefined && steps <= plans.length) {
      if (seen.has(cur)) {
        problems.push(`Projects form a parent loop (through "${p.name}").`)
        break
      }
      seen.add(cur)
      cur = parent.get(cur)
      steps++
    }
  }
}
