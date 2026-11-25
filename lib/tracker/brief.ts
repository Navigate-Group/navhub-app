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
  | { type: 'error'; text: string }

/** A single chat message exchanged with the client. */
export type BriefMessage = { role: 'user' | 'assistant'; content: string }

/** Per-line result after applying. */
export type ApplyResult = { id: string; ok: boolean; error?: string }

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
      'source, action type and milestone status. Dates are YYYY-MM-DD, worked out ' +
      'from the group\'s today. Do NOT invent ids. Never delete or archive anything.',
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
            },
            required: ['kind', 'label'],
          },
        },
      },
      required: ['changes'],
    },
  },
] as const
