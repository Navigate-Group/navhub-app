/**
 * Tracker import translator (P4).
 * ──────────────────────────────────────────────────────────────────────────
 * Reads the previous tracker's export file and translates it into the
 * payload that migration 084's tracker_import_apply() saves in one
 * transaction. Pure functions, no imports, no database: the API routes pass
 * in the group's people, lookups and what is already imported.
 *
 *   parseExport(raw)               → the file's records, or what is wrong with it
 *   translateExport(file, context) → { payload, preview }
 *
 * The old values map to the agreed lookup keys (data model section 5).
 * Records are matched on the old tracker's ids (legacy_id), so importing the
 * same file again updates instead of duplicating. Fields the tracker has no
 * place for are left out, and the preview says so.
 */

// ── The old tracker's export file ──────────────────────────────────────────

export type OldMilestone = { label?: string; date?: string; done?: boolean }

export type OldProject = {
  id: string
  name?: string
  category?: string
  status?: string
  client?: string
  phase?: string
  summary?: string
  folder?: string
  milestones?: OldMilestone[]
  order?: number
  updated?: string
  parentId?: string
  region?: string
}

export type OldAction = {
  id: string
  title?: string
  projectId?: string
  kind?: string
  who?: string
  due?: string
  status?: string
  priority?: string
  notes?: string
  created?: string
  waitingSince?: string
  doneOn?: string
  newOwner?: string
}

export type OldContact = {
  id: string
  name?: string
  org?: string
  role?: string
  phone?: string
  email?: string
  projects?: string[]
  lastContact?: string
  notes?: string
}

export type OldUpdate = { id: string; projectId?: string; date?: string; source?: string; text?: string }

export type OldHandover = {
  id: string
  owner?: string
  position?: string
  people?: string
  decisions?: string
  risks?: string
  access?: string
  firstMoves?: string
  updated?: string
}

export type OldReview = { id: string; checks?: Record<string, unknown> }

export type OldExport = {
  projects: OldProject[]
  actions: OldAction[]
  contacts: OldContact[]
  updates: OldUpdate[]
  handover: OldHandover[]
  reviews: OldReview[]
}

// ── What the database function takes (migration 084) ───────────────────────

export type ImportPayload = {
  regions: { key: string; label: string }[]
  plans: {
    legacy_id: string; name: string; category: string; status: string | null
    client: string | null; phase: string | null; summary: string | null; folder: string | null
    region: string | null; sort_order: number; owner_id: string
    parent_legacy_id: string | null; updated_on: string | null
  }[]
  milestones: {
    plan_legacy_id: string; legacy_id: string; title: string
    due_on: string | null; status: string; sort_order: number
  }[]
  contacts: {
    legacy_id: string; name: string; org: string | null; role: string | null
    phone: string | null; email: string | null; notes: string | null
    last_contact: string | null; plan_legacy_ids: string[]
  }[]
  actions: {
    legacy_id: string; plan_legacy_id: string; title: string; type: string | null
    who: string | null; contact_legacy_id: string | null; assignee_id: string | null
    due_on: string | null; status: string; priority: string; notes: string | null
    created_on: string | null; waiting_since: string | null; done_on: string | null
  }[]
  updates: {
    legacy_id: string; plan_legacy_id: string; kind: 'update' | 'handover'
    date: string | null; source: string | null; text: string
  }[]
  reviews: { iso_week: string; checks: Record<string, boolean> }[]
}

// ── What the routes pass in ────────────────────────────────────────────────

export type ImportPerson = { id: string; name: string; role: string }

export type ExistingPlan = { legacy_id: string; owner_id: string; archived: boolean }

export type ImportContext = {
  importerId: string
  /** Members of the group (from getGroupPeople). */
  people: ImportPerson[]
  /** The group's region lookups, to reuse a region that already exists. */
  regions: { key: string; label: string }[]
  /** Records already imported into this group, by legacy_id. */
  existing: {
    plans: ExistingPlan[]
    actions: string[]
    contacts: string[]
    updates: string[]
  }
  /** Owners chosen in the preview, by the old project id. */
  owners?: Record<string, string>
}

export type CountPair = { new: number; existing: number }

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
    legacy_id: string; name: string; category: string; status: string | null
    parent_name: string | null; owner_id: string; is_new: boolean; archived: boolean
  }[]
  regions_to_add: string[]
  /** Problems that stop the import. */
  errors: string[]
  /** Things the importer should know; the import can go ahead. */
  notes: string[]
}

// ── Value maps: old value → agreed key ─────────────────────────────────────

export const CATEGORY_MAP: Record<string, string> = {
  product: 'product_software',
  data: 'data_science_ci',
  trials: 'partners_field_trials',
  pipeline: 'proposals_pipeline',
  grants: 'grants',
}

export const STATUS_MAP: Record<string, string> = {
  'on-track': 'on_track',
  'at-risk': 'at_risk',
  blocked: 'blocked',
  waiting: 'waiting_on_others',
  proposal: 'proposal_pre_contract',
  closing: 'wrapping_up',
  check: 'needs_status_check',
  done: 'finished',
}

export const ACTION_TYPE_MAP: Record<string, string> = {
  do: 'do',
  call: 'call',
  email: 'email',
  chase: 'chase',
  decide: 'decide',
  meet: 'meeting',
}

export const SOURCE_MAP: Record<string, string> = {
  comment: 'my_note',
  email: 'email',
  meeting: 'meeting',
  call: 'call',
  file: 'file_folder',
  screenshot: 'screenshot',
}

export const ACTION_STATUSES = ['open', 'waiting', 'done']
export const PRIORITIES = ['normal', 'high']

/** Weekly review steps: old check name → review_step key. */
export const REVIEW_CHECK_MAP: Record<string, string> = {
  inbox: 'clear_inbox',
}

/** Handover note sections, in the order they appear in the note. */
export const HANDOVER_SECTIONS: { field: keyof OldHandover; heading: string }[] = [
  { field: 'position', heading: 'Where it stands' },
  { field: 'people', heading: 'People' },
  { field: 'decisions', heading: 'Decisions made' },
  { field: 'risks', heading: 'Risks and watch-outs' },
  { field: 'access', heading: 'Where things live' },
  { field: 'firstMoves', heading: 'First moves' },
]

// ── Small helpers ──────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const WEEK_RE = /^\d{4}-W\d{2}$/

/** Trimmed text, or null when empty or not a string. */
export function text(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

/** A 'YYYY-MM-DD' date, null when empty; undefined when present but invalid. */
export function dateOrNull(v: unknown): string | null | undefined {
  const t = text(v)
  if (t === null) return null
  if (!DATE_RE.test(t)) return undefined
  const d = new Date(t + 'T00:00:00Z')
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t ? undefined : t
}

/** Lower-case, single-spaced, for matching names and milestone titles. */
export function normalise(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** A lookup key made from a label: "Example: white label" → "example_white_label". */
export function keyFromLabel(label: string): string {
  return normalise(label).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'region'
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

// ── parseExport ────────────────────────────────────────────────────────────

/**
 * Check the file has the old tracker's shape. Lists that are missing count as
 * empty; every record needs an id. Other top-level keys are ignored.
 */
export function parseExport(raw: unknown): { ok: true; data: OldExport } | { ok: false; errors: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ["This isn't an export file from the previous tracker."] }
  }
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.projects)) {
    return { ok: false, errors: ['The file has no "projects" list, so it isn\'t an export from the previous tracker.'] }
  }

  const errors: string[] = []
  const lists = ['projects', 'actions', 'contacts', 'updates', 'handover', 'reviews'] as const
  const data = {} as OldExport
  for (const list of lists) {
    if (obj[list] !== undefined && !Array.isArray(obj[list])) {
      errors.push(`"${list}" should be a list.`)
    }
    const items = asArray<Record<string, unknown>>(obj[list])
    const seen: Record<string, true> = {}
    items.forEach((item, i) => {
      const id = item && typeof item === 'object' ? text(item.id) : null
      if (!id) errors.push(`${list} item ${i + 1} has no id.`)
      else if (seen[id]) errors.push(`${list}: the id "${id}" appears twice.`)
      else seen[id] = true
    })
    ;(data as Record<string, unknown>)[list] = items
  }
  return errors.length ? { ok: false, errors } : { ok: true, data }
}

// ── translateExport ────────────────────────────────────────────────────────

export function translateExport(file: OldExport, ctx: ImportContext): { payload: ImportPayload; preview: ImportPreview } {
  const errors: string[] = []
  const notes: string[] = []
  const unmatchedOwners: Record<string, true> = {}

  const existingPlans: Record<string, ExistingPlan> = {}
  for (const p of ctx.existing.plans) existingPlans[p.legacy_id] = p
  const inSet = (ids: string[]) => {
    const m: Record<string, true> = {}
    for (const id of ids) m[id] = true
    return m
  }
  const existingActions = inSet(ctx.existing.actions)
  const existingContacts = inSet(ctx.existing.contacts)
  const existingUpdates = inSet(ctx.existing.updates)

  const peopleByName: Record<string, ImportPerson[]> = {}
  for (const p of ctx.people) {
    if (!p.name) continue
    ;(peopleByName[normalise(p.name)] ??= []).push(p)
  }
  const editorIds = inSet(ctx.people.filter((p) => p.role === 'manager' || p.role === 'group_owner').map((p) => p.id))

  const projectsById: Record<string, OldProject> = {}
  for (const p of file.projects) projectsById[p.id] = p
  const planKnown = (id: string | null | undefined): boolean =>
    !!id && (projectsById[id] !== undefined || existingPlans[id] !== undefined)

  const checkDate = (v: unknown, where: string): string | null => {
    const d = dateOrNull(v)
    if (d === undefined) {
      errors.push(`${where}: "${String(v)}" isn't a date (YYYY-MM-DD).`)
      return null
    }
    return d
  }

  // ── Regions ──
  const regionKeyByLabel: Record<string, string> = {}
  for (const r of ctx.regions) regionKeyByLabel[normalise(r.label)] = r.key
  const regionsToAdd: { key: string; label: string }[] = []
  const regionKey = (label: string): string => {
    const n = normalise(label)
    const found = regionKeyByLabel[n]
    if (found) return found
    let key = keyFromLabel(label)
    const taken = (k: string) => ctx.regions.some((r) => r.key === k) || regionsToAdd.some((r) => r.key === k)
    for (let i = 2; taken(key); i++) key = `${keyFromLabel(label)}_${i}`
    regionsToAdd.push({ key, label: label.trim() })
    regionKeyByLabel[n] = key
    return key
  }

  // ── Plans ──
  const payload: ImportPayload = {
    regions: regionsToAdd, plans: [], milestones: [], contacts: [], actions: [], updates: [], reviews: [],
  }
  const previewPlans: ImportPreview['plans'] = []

  for (const p of file.projects) {
    const where = `Project "${text(p.name) ?? p.id}"`
    const name = text(p.name)
    if (!name) errors.push(`Project ${p.id} has no name.`)

    const category = CATEGORY_MAP[text(p.category) ?? '']
    if (!category) errors.push(`${where}: unknown category "${p.category ?? ''}".`)

    const rawStatus = text(p.status)
    const status = rawStatus === null ? null : STATUS_MAP[rawStatus] ?? null
    if (rawStatus !== null && !status) errors.push(`${where}: unknown status "${rawStatus}".`)

    const parent = text(p.parentId)
    if (parent && !planKnown(parent)) errors.push(`${where}: its parent project "${parent}" isn't in the file.`)
    if (parent === p.id) errors.push(`${where} is its own parent.`)

    const existing = existingPlans[p.id]
    const chosen = ctx.owners?.[p.id]
    let ownerId = existing?.owner_id ?? ctx.importerId
    if (chosen) {
      if (editorIds[chosen]) ownerId = chosen
      else errors.push(`${where}: the chosen owner must be a Manager or Group Owner of the group.`)
    }

    const region = text(p.region)
    const order = typeof p.order === 'number' && Number.isFinite(p.order) ? Math.round(p.order) : 0

    payload.plans.push({
      legacy_id: p.id,
      name: name ?? p.id,
      category: category ?? '',
      status,
      client: text(p.client),
      phase: text(p.phase),
      summary: text(p.summary),
      folder: text(p.folder),
      region: region ? regionKey(region) : null,
      sort_order: order,
      owner_id: ownerId,
      parent_legacy_id: parent,
      updated_on: checkDate(p.updated, `${where} last updated`),
    })
    previewPlans.push({
      legacy_id: p.id,
      name: name ?? p.id,
      category: category ?? '',
      status,
      parent_name: parent ? text(projectsById[parent]?.name) ?? parent : null,
      owner_id: ownerId,
      is_new: !existing,
      archived: existing?.archived ?? false,
    })

    // Milestones: no ids in the file, so a milestone is known by its title.
    const seenTitles: Record<string, number> = {}
    asArray<OldMilestone>(p.milestones).forEach((m, i) => {
      const title = text(m?.label)
      if (!title) {
        errors.push(`${where}: milestone ${i + 1} has no title.`)
        return
      }
      const base = normalise(title)
      seenTitles[base] = (seenTitles[base] ?? 0) + 1
      payload.milestones.push({
        plan_legacy_id: p.id,
        legacy_id: seenTitles[base] > 1 ? `${base} #${seenTitles[base]}` : base,
        title,
        due_on: checkDate(m.date, `${where} milestone "${title}"`),
        status: m.done === true ? 'completed' : 'planned',
        sort_order: i,
      })
    })
  }

  // Parent loops (A inside B inside A).
  for (const p of file.projects) {
    const visited: Record<string, true> = { [p.id]: true }
    let cur = text(p.parentId)
    while (cur && projectsById[cur]) {
      if (visited[cur]) {
        errors.push(`Project "${text(p.name) ?? p.id}" ends up inside one of its own sub-projects.`)
        break
      }
      visited[cur] = true
      cur = text(projectsById[cur].parentId)
    }
  }

  // ── Contacts ──
  const contactsByName: Record<string, string[]> = {}
  for (const c of file.contacts) {
    const where = `Contact "${text(c.name) ?? c.id}"`
    const name = text(c.name)
    if (!name) errors.push(`Contact ${c.id} has no name.`)
    else (contactsByName[normalise(name)] ??= []).push(c.id)
    const links: string[] = []
    for (const pid of asArray<string>(c.projects)) {
      if (planKnown(pid)) {
        if (!links.includes(pid)) links.push(pid)
      } else notes.push(`${where}: link to project "${pid}" left out (not in the file).`)
    }
    payload.contacts.push({
      legacy_id: c.id,
      name: name ?? c.id,
      org: text(c.org),
      role: text(c.role),
      phone: text(c.phone),
      email: text(c.email),
      notes: text(c.notes),
      last_contact: checkDate(c.lastContact, `${where} last contact`),
      plan_legacy_ids: links,
    })
  }

  // ── Actions ──
  for (const a of file.actions) {
    const where = `Action "${text(a.title) ?? a.id}"`
    const title = text(a.title)
    if (!title) errors.push(`Action ${a.id} has no title.`)
    const plan = text(a.projectId)
    if (!planKnown(plan)) errors.push(`${where}: its project "${a.projectId ?? ''}" isn't in the file.`)

    const rawKind = text(a.kind)
    const type = rawKind === null ? null : ACTION_TYPE_MAP[rawKind] ?? null
    if (rawKind !== null && !type) errors.push(`${where}: unknown type "${rawKind}".`)

    const status = text(a.status) ?? 'open'
    if (!ACTION_STATUSES.includes(status)) errors.push(`${where}: unknown status "${status}".`)
    const priority = text(a.priority) ?? 'normal'
    if (!PRIORITIES.includes(priority)) errors.push(`${where}: unknown priority "${priority}".`)

    // Assignee: the new owner, when that name is exactly one member of the group.
    let assignee: string | null = null
    const newOwner = text(a.newOwner)
    if (newOwner) {
      const matches = peopleByName[normalise(newOwner)] ?? []
      if (matches.length === 1) assignee = matches[0].id
      else unmatchedOwners[newOwner] = true
    }

    // Contact: "who", when it is exactly one contact's name.
    const who = text(a.who)
    const contactIds = who ? contactsByName[normalise(who)] ?? [] : []

    payload.actions.push({
      legacy_id: a.id,
      plan_legacy_id: plan ?? '',
      title: title ?? a.id,
      type,
      who,
      contact_legacy_id: contactIds.length === 1 ? contactIds[0] : null,
      assignee_id: assignee,
      due_on: checkDate(a.due, `${where} due date`),
      status,
      priority,
      notes: text(a.notes),
      created_on: checkDate(a.created, `${where} created date`),
      waiting_since: checkDate(a.waitingSince, `${where} waiting since`),
      done_on: checkDate(a.doneOn, `${where} done on`),
    })
  }

  // ── Updates ──
  for (const u of file.updates) {
    const where = `Update ${u.id}`
    const body = text(u.text)
    const plan = text(u.projectId)
    if (!planKnown(plan)) errors.push(`${where}: its project "${u.projectId ?? ''}" isn't in the file.`)
    const rawSource = text(u.source)
    const source = rawSource === null ? null : SOURCE_MAP[rawSource] ?? null
    if (rawSource !== null && !source) errors.push(`${where}: unknown source "${rawSource}".`)
    if (!body) {
      notes.push(`${where} is empty and was left out.`)
      continue
    }
    payload.updates.push({
      legacy_id: u.id,
      plan_legacy_id: plan ?? '',
      kind: 'update',
      date: checkDate(u.date, `${where} date`),
      source,
      text: body,
    })
  }

  // ── Handover notes: one per project, saved as a handover update ──
  let handoverCount = 0
  for (const h of file.handover) {
    if (!planKnown(h.id)) {
      notes.push(`Handover note for "${h.id}" left out (project not in the file).`)
      continue
    }
    const parts: string[] = []
    const owner = text(h.owner)
    if (owner) parts.push(`**Taking over:** ${owner}`)
    for (const s of HANDOVER_SECTIONS) {
      const body = text(h[s.field])
      if (body) parts.push(`## ${s.heading}\n${body}`)
    }
    if (parts.length === 0) continue
    handoverCount++
    payload.updates.push({
      legacy_id: `handover:${h.id}`,
      plan_legacy_id: h.id,
      kind: 'handover',
      date: checkDate(h.updated, `Handover note for "${h.id}"`),
      source: null,
      text: parts.join('\n\n'),
    })
  }

  // ── Weekly reviews ──
  const droppedChecks: Record<string, true> = {}
  for (const r of file.reviews) {
    if (!WEEK_RE.test(r.id)) {
      notes.push(`Weekly review "${r.id}" left out (not a week like 2026-W43).`)
      continue
    }
    const checks: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(r.checks ?? {})) {
      const step = REVIEW_CHECK_MAP[k]
      if (step) checks[step] = v === true
      else droppedChecks[k] = true
    }
    payload.reviews.push({ iso_week: r.id, checks })
  }

  // ── Notes for the preview ──
  const owners = Object.keys(unmatchedOwners)
  if (owners.length) {
    notes.push(`No group member matches these names, so their actions have no assignee: ${owners.join(', ')}.`)
  }
  const dropped = Object.keys(droppedChecks)
  if (dropped.length) notes.push(`Weekly review steps left out: ${dropped.join(', ')}.`)
  if (payload.reviews.length) notes.push('Weekly reviews are saved as your own.')
  if (payload.updates.length) notes.push('Imported updates and handover notes show you as the author.')

  const pair = (ids: string[], have: Record<string, unknown>): CountPair => {
    const existing = ids.filter((id) => have[id] !== undefined).length
    return { new: ids.length - existing, existing }
  }

  const preview: ImportPreview = {
    counts: {
      plans: pair(payload.plans.map((p) => p.legacy_id), existingPlans),
      actions: pair(payload.actions.map((a) => a.legacy_id), existingActions),
      contacts: pair(payload.contacts.map((c) => c.legacy_id), existingContacts),
      updates: pair(payload.updates.filter((u) => u.kind === 'update').map((u) => u.legacy_id), existingUpdates),
      milestones: payload.milestones.length,
      handover: handoverCount,
      reviews: payload.reviews.length,
    },
    plans: previewPlans,
    regions_to_add: regionsToAdd.map((r) => r.label),
    errors,
    notes,
  }
  return { payload, preview }
}
