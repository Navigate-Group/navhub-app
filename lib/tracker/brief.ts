/**
 * Briefing agent — shared types and helpers (server + client safe).
 * ──────────────────────────────────────────────────────────────────────────
 * The Briefing agent on My Summary lets a person describe what happened in
 * their own words. The model NEVER writes to the database: it only reads
 * (through a look-up tool on the conversation route) and returns either a
 * question (`ask_user`) or a list of proposed changes (`propose_changes`).
 * Applying the ticked changes is a separate, server-validated step that goes
 * through the same Supabase server client as the person, so the tracker's
 * access rules (migration 082) decide exactly as on the normal screens.
 *
 * This module holds the structured shapes shared between the conversation
 * route, the apply route and the client component. It must not import any
 * server-only modules so the client can use the types.
 */

/** The model (Anthropic) used by the Briefing agent — NavHub's usual key order. */
export const BRIEF_MODEL = 'claude-sonnet-5-5'

/** Safety caps for the server-side tool loop. */
export const BRIEF_MAX_STEPS = 8
export const BRIEF_MAX_TOKENS = 2048
export const BRIEF_TIMEOUT_MS = 60_000

// ── Proposed changes ─────────────────────────────────────────────────────────

/**
 * The kinds of change the agent may propose. Each maps to one or more existing
 * tracker write routes' logic, reused in the apply route — nothing here can
 * delete, archive, change project access or touch Settings.
 */
export type ProposedChange =
  | {
      kind: 'log_update'
      planId: string
      /** 'YYYY-MM-DD'; omitted → the group's today (DB default). */
      date?: string | null
      /** Lookup key from the group's `source` list. */
      source?: string | null
      text: string
    }
  | {
      kind: 'add_action'
      planId: string
      title: string
      /** Lookup key from the group's `action_type` list. */
      type?: string | null
      /** Free-text counterparty ("with {who}"). */
      who?: string | null
      /** A group member's user id. */
      assigneeId?: string | null
      dueOn?: string | null
      milestoneId?: string | null
      contactId?: string | null
    }
  | {
      kind: 'update_action'
      actionId: string
      /** Set the action's status. */
      status?: 'open' | 'waiting' | 'done' | null
      dueOn?: string | null
      assigneeId?: string | null
      title?: string | null
    }
  | {
      kind: 'add_milestone'
      planId: string
      title: string
      /** Lookup key from the group's `milestone_status` list. */
      status?: string | null
      dueOn?: string | null
      progressPct?: number | null
    }
  | {
      kind: 'update_milestone'
      milestoneId: string
      status?: string | null
      dueOn?: string | null
      progressPct?: number | null
    }
  | {
      kind: 'update_plan'
      planId: string
      status?: string | null
      phase?: string | null
      summary?: string | null
      priority?: 'normal' | 'high' | null
      progressPct?: number | null
      startOn?: string | null
      endOn?: string | null
    }
  | {
      kind: 'add_contact'
      planId: string
      name: string
      org?: string | null
      role?: string | null
      phone?: string | null
      email?: string | null
    }
  | {
      kind: 'link_contact'
      planId: string
      contactId: string
    }
  | {
      kind: 'contacted_today'
      contactId: string
    }
  | {
      kind: 'create_project'
      /** Project name (required). */
      name: string
      /** Category key from the group's `category` list (required). */
      category: string
      /** Status key from the group's `status` list. */
      status?: string | null
      /** Free-text client/organisation. */
      client?: string | null
      /** Free-text phase. */
      phase?: string | null
      /** Region key from the group's `region` list. */
      region?: string | null
      /** An EXISTING parent project the person can see. */
      parentId?: string | null
      /** A group member's user id (the project lead). */
      leadId?: string | null
      /** Group members' user ids. */
      memberIds?: string[] | null
      summary?: string | null
    }
  | {
      kind: 'update_contact'
      contactId: string
      phone?: string | null
      email?: string | null
      org?: string | null
      role?: string | null
      notes?: string | null
    }
  | {
      kind: 'add_comment'
      planId: string
      text: string
    }

export type ProposedChangeKind = ProposedChange['kind']

/** A proposed change plus the plain-words line the confirm card shows. */
export type ProposedChangeItem = {
  /** Stable id so the client can tick/untick and report per-line results. */
  id: string
  /** Plain-words description with the project name, e.g. "Field trials – NSW: …". */
  label: string
  change: ProposedChange
}

/** What the conversation route returns to the client after each turn. */
export type BriefTurn =
  | { type: 'message'; text: string }
  | { type: 'question'; text: string; options: string[] }
  | { type: 'proposal'; intro: string | null; changes: ProposedChangeItem[] }
  /** A plain-text answer to a question — never proposes or saves anything. */
  | { type: 'answer'; text: string }
  | { type: 'error'; text: string }

/** A single chat message exchanged with the client. */
export type BriefMessage = { role: 'user' | 'assistant'; content: string }

/** Per-line result after applying. */
export type ApplyResult = { id: string; ok: boolean; error?: string }

/** Per-turn metrics for the briefing conversation route (not stored in the DB). */
export type BriefMetrics = {
  /** Wall-clock time for the whole turn, in milliseconds. */
  elapsedMs: number
  /** Number of calls made to the model this turn. */
  modelCalls: number
  /** Input tokens summed across this turn's model calls. */
  inputTokens: number
  /** Output tokens summed across this turn's model calls. */
  outputTokens: number
}

// ── Patch building (pure; shared by the apply route and tests) ───────────────
//
// These turn a validated ProposedChange into the exact object written to the
// database. The rule the whole feature depends on: a field the model did NOT
// provide is OMITTED from the patch, so it is left unchanged. A field is only
// written when the change actually carries a value for it. This is what stops a
// status-only project change clearing its phase/summary, or a done-only action
// change clearing its assignee.

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** True when v is a valid 'YYYY-MM-DD' date string. */
export function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && ISO_DATE_RE.test(v)
}

/** Clamp a progress percentage to a whole 0–100, or undefined when absent. */
export function clampPct(v: number | null | undefined): number | undefined {
  if (v === null || v === undefined || !Number.isFinite(v)) return undefined
  return Math.max(0, Math.min(100, Math.round(v)))
}

/**
 * Build the `tracker_actions` update patch for an `update_action` change.
 * Only the fields the model provided are included; a date that isn't a real
 * ISO date throws (callers surface the "Invalid due date" message). The
 * assignee is only set when the change carries one — an omitted assignee is
 * left exactly as it was.
 */
export function buildActionPatch(
  change: Extract<ProposedChange, { kind: 'update_action' }>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (change.status) patch.status = change.status
  if (change.dueOn !== undefined && change.dueOn !== null) {
    if (!isIsoDate(change.dueOn)) throw new Error('Invalid due date')
    patch.due_on = change.dueOn
  }
  // Only touch the assignee when the model actually provided one. (A null that
  // reached here would be an explicit clear; an omitted field stays undefined.)
  if (change.assigneeId !== undefined) patch.assignee_id = change.assigneeId
  if (change.title) patch.title = change.title.trim()
  return patch
}

/** Build the `tracker_milestones` update patch for an `update_milestone` change. */
export function buildMilestonePatch(
  change: Extract<ProposedChange, { kind: 'update_milestone' }>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (change.status) patch.status = change.status
  if (change.dueOn !== undefined && change.dueOn !== null) {
    if (!isIsoDate(change.dueOn)) throw new Error('Invalid due date')
    patch.due_on = change.dueOn
  }
  const pct = clampPct(change.progressPct)
  if (pct !== undefined) {
    patch.progress_pct = pct
    // A milestone in 'from_actions' mode takes its progress from its actions
    // (tracker_v_milestone_progress) and ignores progress_pct, so setting a
    // hand value wouldn't show. Switch it to 'manual' whenever a progress value
    // is given so the new percentage sticks and shows on the page.
    patch.progress_mode = 'manual'
  }
  return patch
}

/** Build the `tracker_project_plans` update patch for an `update_plan` change. */
export function buildPlanPatch(
  change: Extract<ProposedChange, { kind: 'update_plan' }>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (change.status) patch.status = change.status
  // Phase and summary are only written when provided — an omitted field is left
  // unchanged (the data-loss bug was writing null here).
  if (change.phase !== undefined) patch.phase = change.phase
  if (change.summary !== undefined) patch.summary = change.summary
  if (change.priority) patch.priority = change.priority
  const pct = clampPct(change.progressPct)
  if (pct !== undefined) patch.progress_pct = pct
  if (change.startOn !== undefined && change.startOn !== null) {
    if (!isIsoDate(change.startOn)) throw new Error('Invalid start date')
    patch.start_on = change.startOn
  }
  if (change.endOn !== undefined && change.endOn !== null) {
    if (!isIsoDate(change.endOn)) throw new Error('Invalid end date')
    patch.end_on = change.endOn
  }
  return patch
}

/**
 * Build the `tracker_contacts` update patch for an `update_contact` change.
 * Only the fields the model provided are included — the same "omit what wasn't
 * given" rule as the project and action patches, so a phone-only edit never
 * touches the contact's email, organisation, role or notes. An explicit null
 * (an intentional clear) is kept; an omitted field stays out of the patch.
 */
export function buildContactPatch(
  change: Extract<ProposedChange, { kind: 'update_contact' }>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (change.phone !== undefined) patch.phone = change.phone ?? null
  if (change.email !== undefined) patch.email = change.email ?? null
  if (change.org !== undefined) patch.org = change.org ?? null
  if (change.role !== undefined) patch.role = change.role ?? null
  if (change.notes !== undefined) patch.notes = change.notes ?? null
  return patch
}

/**
 * Whether a `create_project` change must be refused before any write, and why.
 * Returns an error string (the line's refusal), or null when it may proceed.
 * Only Managers / Group Owners (editor === true) may create a project; the name
 * and category are required. Lookup-key and parent-existence checks happen in
 * the apply route, where the group's valid keys and the database are available.
 */
export function createProjectRefusal(
  change: Extract<ProposedChange, { kind: 'create_project' }>,
  editor: boolean,
): string | null {
  if (!editor) return 'Only Managers or Group Owners can create a project'
  if (!change.name?.trim()) return 'A project name is required'
  if (!change.category?.trim()) return 'A category is required'
  return null
}

// ── Reading the model's propose_changes input ────────────────────────────────
//
// These turn the model's raw `propose_changes` tool input into typed
// ProposedChangeItems — the first half of the pipeline that ends at the patch
// builders above. The same omit-don't-clear rule governs here: a field the
// model did NOT provide is left `undefined` (never coerced to `null`), so the
// apply route only writes fields the model actually meant to set. `set()` adds
// a key only when the value is defined; this is what keeps a status-only
// project change from carrying its phase/summary, or a done-only action change
// from carrying its assignee. (Moved here from the brief route so the step can
// be tested from raw model input through to the final patch.)

/** Trim a possibly-missing string field; '' / non-strings become undefined. */
function s(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t === '' ? undefined : t
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

/** A de-duplicated array of non-empty trimmed strings, or undefined when absent/empty. */
function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of v) {
    if (typeof item !== 'string') continue
    const t = item.trim()
    if (t && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out.length > 0 ? out : undefined
}

/**
 * Turn the model's raw change into a typed ProposedChange. A field the model
 * did NOT provide is OMITTED (left `undefined`), never coerced to `null` — so
 * the apply route only ever writes fields the model actually meant to set, and
 * never wipes data the person didn't mention.
 */
export function toChange(kind: string | undefined, r: Record<string, unknown>): ProposedChange | null {
  const planId = s(r.planId)
  const status = s(r.status)

  /** Assign a field only when it has a real value (omit when undefined). */
  const set = <T extends Record<string, unknown>, K extends string>(
    obj: T,
    key: K,
    value: unknown,
  ): void => {
    if (value !== undefined) (obj as Record<string, unknown>)[key] = value
  }

  switch (kind) {
    case 'log_update': {
      const text = s(r.text)
      if (!planId || !text) return null
      const c: ProposedChange = { kind, planId, text }
      set(c, 'date', s(r.date))
      set(c, 'source', s(r.source))
      return c
    }
    case 'add_action': {
      const title = s(r.title)
      if (!planId || !title) return null
      const c: ProposedChange = { kind, planId, title }
      set(c, 'type', s(r.type))
      set(c, 'who', s(r.who))
      set(c, 'assigneeId', s(r.assigneeId))
      set(c, 'dueOn', s(r.dueOn))
      set(c, 'milestoneId', s(r.milestoneId))
      set(c, 'contactId', s(r.contactId))
      return c
    }
    case 'update_action': {
      const actionId = s(r.actionId)
      if (!actionId) return null
      const st =
        status === 'open' || status === 'waiting' || status === 'done' ? status : undefined
      const c: ProposedChange = { kind, actionId }
      set(c, 'status', st)
      set(c, 'dueOn', s(r.dueOn))
      set(c, 'assigneeId', s(r.assigneeId))
      set(c, 'title', s(r.title))
      return c
    }
    case 'add_milestone': {
      const title = s(r.title)
      if (!planId || !title) return null
      const c: ProposedChange = { kind, planId, title }
      set(c, 'status', s(r.status))
      set(c, 'dueOn', s(r.dueOn))
      set(c, 'progressPct', num(r.progressPct))
      return c
    }
    case 'update_milestone': {
      const milestoneId = s(r.milestoneId)
      if (!milestoneId) return null
      const c: ProposedChange = { kind, milestoneId }
      set(c, 'status', s(r.status))
      set(c, 'dueOn', s(r.dueOn))
      set(c, 'progressPct', num(r.progressPct))
      return c
    }
    case 'update_plan': {
      if (!planId) return null
      const pri = s(r.priority)
      const c: ProposedChange = { kind, planId }
      set(c, 'status', s(r.status))
      set(c, 'phase', s(r.phase))
      set(c, 'summary', s(r.summary))
      set(c, 'priority', pri === 'high' || pri === 'normal' ? pri : undefined)
      set(c, 'progressPct', num(r.progressPct))
      set(c, 'startOn', s(r.startOn))
      set(c, 'endOn', s(r.endOn))
      return c
    }
    case 'add_contact': {
      const name = s(r.name)
      if (!planId || !name) return null
      const c: ProposedChange = { kind, planId, name }
      set(c, 'org', s(r.org))
      set(c, 'role', s(r.role))
      set(c, 'phone', s(r.phone))
      set(c, 'email', s(r.email))
      return c
    }
    case 'link_contact': {
      const contactId = s(r.contactId)
      if (!planId || !contactId) return null
      return { kind, planId, contactId }
    }
    case 'contacted_today': {
      const contactId = s(r.contactId)
      if (!contactId) return null
      return { kind, contactId }
    }
    case 'create_project': {
      const name = s(r.name)
      const category = s(r.category)
      if (!name || !category) return null
      const c: ProposedChange = { kind, name, category }
      set(c, 'status', status)
      set(c, 'client', s(r.client))
      set(c, 'phase', s(r.phase))
      set(c, 'region', s(r.region))
      set(c, 'parentId', s(r.parentId))
      set(c, 'leadId', s(r.leadId))
      set(c, 'memberIds', strArr(r.memberIds))
      set(c, 'summary', s(r.summary))
      return c
    }
    case 'update_contact': {
      const contactId = s(r.contactId)
      if (!contactId) return null
      const c: ProposedChange = { kind, contactId }
      set(c, 'phone', s(r.phone))
      set(c, 'email', s(r.email))
      set(c, 'org', s(r.org))
      set(c, 'role', s(r.role))
      set(c, 'notes', s(r.notes))
      return c
    }
    case 'add_comment': {
      const text = s(r.text)
      if (!planId || !text) return null
      return { kind, planId, text }
    }
    default:
      return null
  }
}

/**
 * Turn the model's `propose_changes` input into a proposal BriefTurn. Each raw
 * change is normalised to one of the known kinds via toChange(); anything that
 * doesn't carry the ids it needs is dropped (the apply route validates again
 * anyway).
 */
export function buildProposalTurn(
  input: Record<string, unknown>,
  fallbackIntro: string | null,
): BriefTurn {
  const intro = s(input.intro) ?? fallbackIntro
  const raw = Array.isArray(input.changes) ? input.changes : []
  const items: ProposedChangeItem[] = []

  raw.forEach((rc, i) => {
    if (typeof rc !== 'object' || rc === null) return
    const r = rc as Record<string, unknown>
    const kind = s(r.kind)
    const label = s(r.label) ?? 'Change'
    const change = toChange(kind, r)
    if (change) items.push({ id: `c${i}`, label, change })
  })

  return { type: 'proposal', intro, changes: items }
}

// ── Anthropic tool schemas ───────────────────────────────────────────────────

/**
 * The two tools the model may call to finish a turn, plus the look-up tool it
 * uses to fetch a project's details on demand. Kept here so the route and any
 * test share one definition.
 */
export const briefTools = [
  {
    name: 'lookup_project',
    description:
      "Look up one of the signed-in person's visible projects in full: its open " +
      'actions (id, title, type, status, due date, assignee, milestone), its ' +
      'milestones (id, title, status, due date, progress), its recent updates, and ' +
      'its linked contacts (id, name, org). Call this before proposing changes to a ' +
      'project so you use real ids. Only projects the person can see are available.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The id of a visible project.' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'list_open_items',
    description:
      'Read-only: list open and overdue actions and milestones with a due date in a ' +
      'date range, across the person\'s visible projects (or one project). Use this to ' +
      'answer questions like "what\'s overdue on NSW?" or "what\'s due this week?". ' +
      'Dates are YYYY-MM-DD. Omit from/to for no bound on that side; set overdueOnly to ' +
      'list only items due before today. Only items the person can see are returned.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Limit to one visible project (optional).' },
        from: { type: 'string', description: 'Earliest due date, YYYY-MM-DD (optional).' },
        to: { type: 'string', description: 'Latest due date, YYYY-MM-DD (optional).' },
        overdueOnly: { type: 'boolean', description: 'Only items due before today (optional).' },
      },
    },
  },
  {
    name: 'find_contact',
    description:
      'Read-only: find contacts by name (partial match), with the projects they are ' +
      'linked to and their last-contact date. Use this to answer questions like "when ' +
      'did we last speak to Pat?". Only contacts the person can see are returned.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'All or part of the contact\'s name.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'ask_user',
    description:
      'Ask the person ONE short clarifying question when something is genuinely ' +
      'ambiguous (e.g. which of two projects, or who an action goes to). Prefer ' +
      'sensible assumptions over asking. Provide clickable options when you can.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to ~6 short clickable answers; omit for a free-text question.',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'propose_changes',
    description:
      'Return the final list of proposed changes once you are confident. Each change ' +
      'must reference real ids from lookup_project. Use lookup keys (not labels) for ' +
      'source, action type, milestone status, project status, category and region. ' +
      "Dates are YYYY-MM-DD, worked out from the group's today. Do NOT invent ids. " +
      'Never delete or archive anything.\n\n' +
      'Each change kind uses exactly these fields:\n' +
      "- log_update: planId, text, [date], [source] — a dated note on the project's history.\n" +
      '- add_action: planId, title, [type], [who], [assigneeId], [dueOn], [milestoneId], [contactId].\n' +
      '- update_action: actionId, [status (open/waiting/done)], [dueOn], [assigneeId], [title].\n' +
      '- add_milestone: planId, title, [status], [dueOn], [progressPct].\n' +
      '- update_milestone: milestoneId, [status], [dueOn], [progressPct] — a NAMED milestone only.\n' +
      "- update_plan: planId AND the PROJECT'S OWN [status], [phase], [summary], " +
      '[priority (normal/high)], [progressPct 0–100], [startOn], [endOn]. Use this for a ' +
      "project's own status or progress when no milestone is named.\n" +
      '- add_contact: planId, name, [org], [role], [phone], [email] — a new contact linked to the project.\n' +
      '- link_contact: planId, contactId — link an existing contact to the project.\n' +
      '- contacted_today: contactId — move the contact\'s last-contact date to today.\n' +
      '- create_project (Managers/Group Owners only): name, category, [status], [client], ' +
      '[phase], [region], [parentId (an EXISTING visible project)], [leadId], [memberIds], [summary].\n' +
      '- update_contact: contactId AND only the mentioned of [phone], [email], [org], [role], [notes].\n' +
      '- add_comment: planId, text — post a comment on the project.',
    input_schema: {
      type: 'object',
      properties: {
        intro: { type: 'string', description: 'One short sentence summarising the changes (optional).' },
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: [
                  'log_update',
                  'add_action',
                  'update_action',
                  'add_milestone',
                  'update_milestone',
                  'update_plan',
                  'add_contact',
                  'link_contact',
                  'contacted_today',
                  'create_project',
                  'update_contact',
                  'add_comment',
                ],
              },
              label: { type: 'string', description: 'Plain-words line with the project name.' },
              planId: { type: 'string' },
              actionId: { type: 'string' },
              milestoneId: { type: 'string' },
              contactId: { type: 'string' },
              title: { type: 'string' },
              text: { type: 'string' },
              date: { type: 'string' },
              dueOn: { type: 'string' },
              startOn: { type: 'string' },
              endOn: { type: 'string' },
              source: { type: 'string' },
              type: { type: 'string' },
              who: { type: 'string' },
              status: { type: 'string' },
              phase: { type: 'string' },
              summary: { type: 'string' },
              priority: { type: 'string', enum: ['normal', 'high'] },
              progressPct: { type: 'number' },
              assigneeId: { type: 'string' },
              name: { type: 'string' },
              org: { type: 'string' },
              role: { type: 'string' },
              phone: { type: 'string' },
              email: { type: 'string' },
              notes: { type: 'string' },
              category: { type: 'string', description: 'create_project: a key from the group\'s category list.' },
              client: { type: 'string' },
              region: { type: 'string', description: 'create_project: a key from the group\'s region list.' },
              parentId: { type: 'string', description: 'create_project: the id of an EXISTING visible project.' },
              leadId: { type: 'string' },
              memberIds: { type: 'array', items: { type: 'string' }, description: 'create_project: group members\' user ids.' },
            },
            required: ['kind', 'label'],
          },
        },
      },
      required: ['changes'],
    },
  },
  {
    name: 'answer',
    description:
      'Answer the person\'s QUESTION in plain words when they are asking something ' +
      '("what\'s overdue on NSW?", "when did we last speak to Pat?", "who leads the ' +
      'irrigation grant?") rather than reporting what happened. This NEVER proposes or ' +
      'saves anything. Use list_open_items and find_contact (and lookup_project) to get ' +
      'the facts first, then give a short, plain answer naming projects and dates. Only ' +
      'use what the person can see. If they then ask for a change, propose it as usual.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The plain-words answer.' },
      },
      required: ['text'],
    },
  },
] as const
