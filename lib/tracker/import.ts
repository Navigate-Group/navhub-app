/**
 * Project Tracker import translator (P4b).
 * ──────────────────────────────────────────────────────────────────────────
 * Turns the previous tracker's export file into the payload that migration
 * 084's tracker_import_apply(group_id, file_name, payload) saves in one
 * transaction, and builds the preview the wizard shows before any write.
 *
 * Pure TypeScript, NO imports: the next part (P4c) calls parseExport then
 * translateExport, shows the preview (counts, problems, notes, region
 * additions, a project table with an owner dropdown), and on Apply posts the
 * payload. The payload field names match the 084 header exactly.
 *
 * Nothing here touches the database. parseExport validates the file shape;
 * translateExport maps every old value to the agreed lookup keys and stops the
 * import on any unmapped value, bad date, missing/circular parent or missing
 * project link (collected as `errors`); `notes` are information only.
 */

// ── Public types ───────────────────────────────────────────────────────────

export type ImportPerson = { id: string; name: string; role: string }

export type ExistingPlan = { legacy_id: string; owner_id: string; archived: boolean }

export type ImportContext = {
  /** The user applying the import; the default owner/author. */
  importerId: string
  /** The group's members. */
  people: ImportPerson[]
  /** The group's existing region lookups. */
  regions: { key: string; label: string }[]
  /** Legacy ids already imported, so re-import counts as "existing". */
  existing: {
    plans: ExistingPlan[]
    actions: string[]
    contacts: string[]
    updates: string[]
  }
  /** Optional per-project chosen owner: old project id → chosen owner user id. */
  owners?: Record<string, string>
}

export type ImportPayload = {
  regions: { key: string; label: string }[]
  plans: {
    legacy_id: string
    name: string
    category: string | null
    status: string | null
    client: string | null
    phase: string | null
    summary: string | null
    folder: string | null
    region: string | null
    sort_order: number
    owner_id: string
    parent_legacy_id: string | null
    updated_on: string | null
  }[]
  milestones: {
    plan_legacy_id: string
    legacy_id: string
    title: string
    due_on: string | null
    status: string
    sort_order: number
  }[]
  contacts: {
    legacy_id: string
    name: string
    org: string | null
    role: string | null
    phone: string | null
    email: string | null
    notes: string | null
    last_contact: string | null
    plan_legacy_ids: string[]
  }[]
  actions: {
    legacy_id: string
    plan_legacy_id: string
    title: string
    type: string | null
    who: string | null
    contact_legacy_id: string | null
    assignee_id: string | null
    due_on: string | null
    status: string
    priority: string
    notes: string | null
    created_on: string | null
    waiting_since: string | null
    done_on: string | null
  }[]
  updates: {
    legacy_id: string
    plan_legacy_id: string
    kind: string
    date: string | null
    source: string | null
    text: string
  }[]
  reviews: { iso_week: string; checks: Record<string, boolean> }[]
}

type CountPair = { new: number; existing: number }

export type ImportPreview = {
  counts: {
    plans: CountPair
    actions: CountPair
    contacts: CountPair
    updates: CountPair
    milestones: number
    handover: number
    reviews: number
  }
  plans: {
    legacy_id: string
    name: string
    category: string | null
    status: string | null
    parent_name: string | null
    owner_id: string
    is_new: boolean
    archived: boolean
  }[]
  regions_to_add: string[]
  errors: string[]
  notes: string[]
}

// ── Value maps (old → agreed lookup key) ─────────────────────────────────────

const CATEGORY_MAP: Record<string, string> = {
  product: 'product_software',
  data: 'data_science_ci',
  trials: 'partners_field_trials',
  pipeline: 'proposals_pipeline',
  grants: 'grants',
}

const STATUS_MAP: Record<string, string> = {
  'on-track': 'on_track',
  'at-risk': 'at_risk',
  blocked: 'blocked',
  waiting: 'waiting_on_others',
  proposal: 'proposal_pre_contract',
  closing: 'wrapping_up',
  check: 'needs_status_check',
  done: 'finished',
}

const ACTION_KIND_MAP: Record<string, string> = {
  do: 'do',
  call: 'call',
  email: 'email',
  chase: 'chase',
  decide: 'decide',
  meet: 'meeting',
}

const SOURCE_MAP: Record<string, string> = {
  comment: 'my_note',
  file: 'file_folder',
  email: 'email',
  meeting: 'meeting',
  call: 'call',
  screenshot: 'screenshot',
}

const ACTION_STATUS_MAP: Record<string, string> = {
  open: 'open',
  waiting: 'waiting',
  done: 'done',
}

const PRIORITY_MAP: Record<string, string> = {
  normal: 'normal',
  high: 'high',
}

const REVIEW_CHECK_MAP: Record<string, string> = {
  inbox: 'clear_inbox',
}

// ── parseExport ──────────────────────────────────────────────────────────────

export type ParsedExport = {
  projects: RawProject[]
  actions: RawRecord[]
  contacts: RawRecord[]
  updates: RawRecord[]
  handover: RawRecord[]
  reviews: RawRecord[]
}

type RawRecord = Record<string, unknown>
type RawProject = RawRecord & { milestones?: unknown }

function isObject(x: unknown): x is RawRecord {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/**
 * Validate the file shape. Refuses anything that isn't an object with a
 * `projects` list, a list that isn't an array, a record without an `id`, or
 * the same `id` twice in one list.
 */
export function parseExport(
  raw: unknown,
): { ok: true; data: ParsedExport } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!isObject(raw)) {
    return { ok: false, errors: ['The file is not a single JSON object.'] }
  }
  if (!Array.isArray(raw.projects)) {
    return { ok: false, errors: ['The file has no "projects" list.'] }
  }

  // Each of these top-level keys, when present, must be an array of records
  // that each have a unique `id`. `projects` is required; the rest default to [].
  const lists: (keyof ParsedExport)[] = [
    'projects', 'actions', 'contacts', 'updates', 'handover', 'reviews',
  ]
  const out: ParsedExport = {
    projects: [], actions: [], contacts: [], updates: [], handover: [], reviews: [],
  }

  for (const list of lists) {
    const value = (raw as RawRecord)[list]
    if (value === undefined && list !== 'projects') continue
    if (!Array.isArray(value)) {
      errors.push(`"${list}" is not a list.`)
      continue
    }
    const seen = new Set<string>()
    const records: RawRecord[] = []
    for (let i = 0; i < value.length; i++) {
      const item = value[i]
      if (!isObject(item)) {
        errors.push(`"${list}" item ${i} is not an object.`)
        continue
      }
      const id = item.id
      if (typeof id !== 'string' || id === '') {
        errors.push(`"${list}" item ${i} has no id.`)
        continue
      }
      if (seen.has(id)) {
        errors.push(`"${list}" has the id "${id}" more than once.`)
        continue
      }
      seen.add(id)
      records.push(item)
    }
    ;(out[list] as RawRecord[]) = records
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, data: out }
}

// ── Small value helpers ──────────────────────────────────────────────────────

/** Empty strings become null; anything else is trimmed to a string or null. */
function str(x: unknown): string | null {
  if (typeof x !== 'string') return x == null ? null : String(x)
  const t = x.trim()
  return t === '' ? null : t
}

function num(x: unknown): number | null {
  if (typeof x === 'number' && Number.isFinite(x)) return x
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x)
  return null
}

/** True for a real YYYY-MM-DD date. */
function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

const ISO_WEEK = /^\d{4}-W\d{2}$/

/** Collapse runs of whitespace and lowercase, for matching labels and names. */
function norm(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** A lookup key from a label: lowercase, non-alphanumerics → underscores. */
function keyFromLabel(label: string): string {
  const k = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return k === '' ? 'region' : k
}

// ── translateExport ──────────────────────────────────────────────────────────

export function translateExport(
  data: ParsedExport,
  context: ImportContext,
): { payload: ImportPayload; preview: ImportPreview } {
  const errors: string[] = []
  const notes: string[] = []

  const owners = context.owners ?? {}
  const existingPlans = new Map(context.existing.plans.map((p) => [p.legacy_id, p]))
  const existingActions = new Set(context.existing.actions)
  const existingContacts = new Set(context.existing.contacts)
  const existingUpdates = new Set(context.existing.updates)

  // A date value from the file: empty → null; present but not a real date → error.
  const date = (x: unknown, where: string): string | null => {
    const s = str(x)
    if (s === null) return null
    if (!isValidDate(s)) {
      errors.push(`${where}: "${s}" is not a real YYYY-MM-DD date.`)
      return null
    }
    return s
  }

  // Map a value through a table; any other value is an error.
  const mapped = (
    x: unknown,
    table: Record<string, string>,
    where: string,
  ): string | null => {
    const s = str(x)
    if (s === null) return null
    if (Object.prototype.hasOwnProperty.call(table, s)) return table[s]
    errors.push(`${where}: "${s}" is not a value we know.`)
    return null
  }

  // ── Regions ──
  // Reuse a region whose label matches (case/space-insensitive); otherwise add
  // one with a key from the label, de-duplicated, and list its label.
  const regionByLabel = new Map<string, string>()
  for (const r of context.regions) regionByLabel.set(norm(r.label), r.key)
  const usedKeys = new Set(context.regions.map((r) => r.key))
  const regionsToAdd: { key: string; label: string }[] = []
  const regionsToAddLabels: string[] = []

  const resolveRegion = (label: string | null): string | null => {
    if (label === null) return null
    const n = norm(label)
    const existing = regionByLabel.get(n)
    if (existing !== undefined) return existing
    // Make a unique key from the label.
    const base = keyFromLabel(label)
    let key = base
    let i = 2
    while (usedKeys.has(key)) {
      key = `${base}_${i}`
      i++
    }
    usedKeys.add(key)
    regionByLabel.set(n, key)
    regionsToAdd.push({ key, label })
    regionsToAddLabels.push(label)
    return key
  }

  // ── Plans (first pass: shape, values, owner; parents checked after) ──
  const projectIds = new Set(data.projects.map((p) => String(p.id)))
  const planPreview: ImportPreview['plans'] = []
  const outPlans: ImportPayload['plans'] = []
  const outMilestones: ImportPayload['milestones'] = []
  const nameByLegacyId = new Map<string, string>()

  for (const p of data.projects) {
    const legacyId = String(p.id)
    nameByLegacyId.set(legacyId, str(p.name) ?? legacyId)
  }

  for (const p of data.projects) {
    const legacyId = String(p.id)
    const where = `Project "${legacyId}"`
    const category = mapped(p.category, CATEGORY_MAP, `${where} category`)
    const status = mapped(p.status, STATUS_MAP, `${where} status`)
    const region = resolveRegion(str(p.region))

    // Owner: chosen owner (must be a manager or group_owner), else existing, else importer.
    let ownerId = context.importerId
    const existing = existingPlans.get(legacyId)
    if (existing) ownerId = existing.owner_id
    const chosen = owners[legacyId]
    if (chosen !== undefined) {
      const person = context.people.find((m) => m.id === chosen)
      if (!person || (person.role !== 'manager' && person.role !== 'group_owner')) {
        errors.push(`${where}: the chosen owner must be a Manager or Group Owner.`)
      } else {
        ownerId = chosen
      }
    }

    const parentRaw = str(p.parentId)
    const archived = existing ? existing.archived : false

    outPlans.push({
      legacy_id: legacyId,
      name: str(p.name) ?? legacyId,
      category,
      status,
      client: str(p.client),
      phase: str(p.phase),
      summary: str(p.summary),
      folder: str(p.folder),
      region,
      sort_order: num(p.order) ?? 0,
      owner_id: ownerId,
      parent_legacy_id: parentRaw,
      updated_on: date(p.updated, `${where} updated`),
    })

    planPreview.push({
      legacy_id: legacyId,
      name: str(p.name) ?? legacyId,
      category,
      status,
      parent_name: parentRaw !== null ? nameByLegacyId.get(parentRaw) ?? null : null,
      owner_id: ownerId,
      is_new: !existing,
      archived,
    })

    // ── Milestones inside this project ──
    const rawMilestones = p.milestones
    if (rawMilestones !== undefined) {
      if (!Array.isArray(rawMilestones)) {
        errors.push(`${where}: "milestones" is not a list.`)
      } else {
        const seenLegacy = new Map<string, number>()
        for (let i = 0; i < rawMilestones.length; i++) {
          const m = rawMilestones[i]
          if (!isObject(m)) {
            errors.push(`${where} milestone ${i} is not an object.`)
            continue
          }
          const label = str(m.label)
          if (label === null) {
            errors.push(`${where} milestone ${i} has no label.`)
            continue
          }
          const base = norm(label)
          const count = (seenLegacy.get(base) ?? 0) + 1
          seenLegacy.set(base, count)
          const legacy = count === 1 ? base : `${base} #${count}`
          outMilestones.push({
            plan_legacy_id: legacyId,
            legacy_id: legacy,
            title: label,
            due_on: date(m.date, `${where} milestone "${label}"`),
            status: m.done === true ? 'completed' : 'planned',
            sort_order: i,
          })
        }
      }
    }
  }

  // ── Parent validation: present in file (or already imported), not self, no loop ──
  const importedPlanIds = new Set(existingPlans.keys())
  for (const pl of outPlans) {
    const parent = pl.parent_legacy_id
    if (parent === null) continue
    if (parent === pl.legacy_id) {
      errors.push(`Project "${pl.legacy_id}" is its own parent.`)
      continue
    }
    if (!projectIds.has(parent) && !importedPlanIds.has(parent)) {
      errors.push(`Project "${pl.legacy_id}": its parent "${parent}" is not in the file or already imported.`)
    }
  }
  // Loop detection over the plans in this file.
  const parentOf = new Map<string, string | null>()
  for (const pl of outPlans) parentOf.set(pl.legacy_id, pl.parent_legacy_id)
  for (const pl of outPlans) {
    const seen = new Set<string>()
    let cur: string | null = pl.legacy_id
    let looped = false
    while (cur !== null) {
      if (seen.has(cur)) {
        looped = true
        break
      }
      seen.add(cur)
      cur = parentOf.has(cur) ? parentOf.get(cur)! : null
    }
    if (looped) {
      errors.push(`Project "${pl.legacy_id}" is in a loop of parent projects.`)
    }
  }

  // ── Contacts ──
  const outContacts: ImportPayload['contacts'] = []
  const contactByName = new Map<string, string[]>() // normalised name → contact ids
  for (const c of data.contacts) {
    const legacyId = String(c.id)
    const name = str(c.name) ?? legacyId
    const links = Array.isArray(c.projects) ? c.projects.map((x) => String(x)) : []
    const keptLinks: string[] = []
    for (const link of links) {
      if (projectIds.has(link) || importedPlanIds.has(link)) keptLinks.push(link)
      else notes.push(`Contact "${name}": its link to project "${link}" was dropped (not in the file).`)
    }
    outContacts.push({
      legacy_id: legacyId,
      name,
      org: str(c.org),
      role: str(c.role),
      phone: str(c.phone),
      email: str(c.email),
      notes: str(c.notes),
      last_contact: date(c.lastContact, `Contact "${name}" lastContact`),
      plan_legacy_ids: keptLinks,
    })
    const key = norm(name)
    contactByName.set(key, [...(contactByName.get(key) ?? []), legacyId])
  }

  // People lookup by name (for action assignee matching).
  const peopleByName = new Map<string, string[]>()
  for (const person of context.people) {
    const key = norm(person.name)
    peopleByName.set(key, [...(peopleByName.get(key) ?? []), person.id])
  }

  // ── Actions ──
  const outActions: ImportPayload['actions'] = []
  for (const a of data.actions) {
    const legacyId = String(a.id)
    const title = str(a.title) ?? legacyId
    const planLegacyId = str(a.projectId)
    const where = `Action "${title}"`

    // Assignee: the one person whose name matches newOwner (case-insensitive).
    let assigneeId: string | null = null
    const newOwner = str(a.newOwner)
    if (newOwner !== null) {
      const matches = peopleByName.get(norm(newOwner)) ?? []
      if (matches.length === 1) assigneeId = matches[0]
      else notes.push(`${where}: owner "${newOwner}" did not match exactly one group member.`)
    }

    // Contact: the one contact whose name matches `who`.
    let contactLegacyId: string | null = null
    const who = str(a.who)
    if (who !== null) {
      const matches = contactByName.get(norm(who)) ?? []
      if (matches.length === 1) contactLegacyId = matches[0]
    }

    outActions.push({
      legacy_id: legacyId,
      plan_legacy_id: planLegacyId ?? '',
      title,
      type: mapped(a.kind, ACTION_KIND_MAP, `${where} kind`),
      who,
      contact_legacy_id: contactLegacyId,
      assignee_id: assigneeId,
      due_on: date(a.due, `${where} due`),
      status: mapped(a.status, ACTION_STATUS_MAP, `${where} status`) ?? 'open',
      priority: mapped(a.priority, PRIORITY_MAP, `${where} priority`) ?? 'normal',
      notes: str(a.notes),
      created_on: date(a.created, `${where} created`),
      waiting_since: date(a.waitingSince, `${where} waitingSince`),
      done_on: date(a.doneOn, `${where} doneOn`),
    })
  }

  // ── Updates ──
  const outUpdates: ImportPayload['updates'] = []
  for (const u of data.updates) {
    const legacyId = String(u.id)
    const text = str(u.text)
    if (text === null) {
      notes.push(`Update "${legacyId}" was skipped (no text).`)
      continue
    }
    const where = `Update "${legacyId}"`
    outUpdates.push({
      legacy_id: legacyId,
      plan_legacy_id: str(u.projectId) ?? '',
      kind: 'update',
      date: date(u.date, `${where} date`),
      source: mapped(u.source, SOURCE_MAP, `${where} source`),
      text,
    })
  }

  // ── Handover: one update per project, kind 'handover' ──
  let handoverCount = 0
  for (const h of data.handover) {
    const projectId = String(h.id)
    const owner = str(h.owner)
    const position = str(h.position)
    const people = str(h.people)
    const decisions = str(h.decisions)
    const risks = str(h.risks)
    const access = str(h.access)
    const firstMoves = str(h.firstMoves)

    // Skip a handover with nothing in it.
    if (
      owner === null && position === null && people === null && decisions === null &&
      risks === null && access === null && firstMoves === null
    ) {
      continue
    }

    const parts: string[] = []
    parts.push(`**Taking over:** ${owner ?? ''}`)
    if (position !== null) parts.push(`## Where it stands\n\n${position}`)
    if (people !== null) parts.push(`## People\n\n${people}`)
    if (decisions !== null) parts.push(`## Decisions made\n\n${decisions}`)
    if (risks !== null) parts.push(`## Risks and watch-outs\n\n${risks}`)
    if (access !== null) parts.push(`## Where things live\n\n${access}`)
    if (firstMoves !== null) parts.push(`## First moves\n\n${firstMoves}`)

    outUpdates.push({
      legacy_id: `handover:${projectId}`,
      plan_legacy_id: projectId,
      kind: 'handover',
      date: date(h.updated, `Handover "${projectId}" updated`),
      text: parts.join('\n\n'),
      source: null,
    })
    handoverCount++
  }

  // ── Reviews ──
  const outReviews: ImportPayload['reviews'] = []
  for (const r of data.reviews) {
    const isoWeek = String(r.id)
    if (!ISO_WEEK.test(isoWeek)) {
      notes.push(`Review "${isoWeek}" was skipped (not an ISO week).`)
      continue
    }
    const checks: Record<string, boolean> = {}
    const rawChecks = isObject(r.checks) ? r.checks : {}
    for (const key of Object.keys(rawChecks)) {
      if (Object.prototype.hasOwnProperty.call(REVIEW_CHECK_MAP, key)) {
        checks[REVIEW_CHECK_MAP[key]] = rawChecks[key] === true
      } else {
        notes.push(`Review "${isoWeek}": the check "${key}" was left out.`)
      }
    }
    outReviews.push({ iso_week: isoWeek, checks })
  }
  if (outReviews.length > 0) {
    notes.push('Weekly reviews are saved as your own.')
    notes.push('Imported updates and handover notes show you as the author.')
  }

  // ── Counts (existing = legacy id already in context.existing) ──
  const planCount: CountPair = { new: 0, existing: 0 }
  for (const pl of outPlans) {
    if (existingPlans.has(pl.legacy_id)) planCount.existing++
    else planCount.new++
  }
  const actionCount: CountPair = { new: 0, existing: 0 }
  for (const a of outActions) {
    if (existingActions.has(a.legacy_id)) actionCount.existing++
    else actionCount.new++
  }
  const contactCount: CountPair = { new: 0, existing: 0 }
  for (const c of outContacts) {
    if (existingContacts.has(c.legacy_id)) contactCount.existing++
    else contactCount.new++
  }
  // Handover entries are counted under counts.handover, not counts.updates.
  const updateCount: CountPair = { new: 0, existing: 0 }
  for (const u of outUpdates) {
    if (u.kind === 'handover') continue
    if (existingUpdates.has(u.legacy_id)) updateCount.existing++
    else updateCount.new++
  }

  const payload: ImportPayload = {
    regions: regionsToAdd,
    plans: outPlans,
    milestones: outMilestones,
    contacts: outContacts,
    actions: outActions,
    updates: outUpdates,
    reviews: outReviews,
  }

  const preview: ImportPreview = {
    counts: {
      plans: planCount,
      actions: actionCount,
      contacts: contactCount,
      updates: updateCount,
      milestones: outMilestones.length,
      handover: handoverCount,
      reviews: outReviews.length,
    },
    plans: planPreview,
    regions_to_add: regionsToAddLabels,
    errors,
    notes,
  }

  return { payload, preview }
}
