/**
 * Tracker history view-model (P5.1) — pure, client-safe.
 * ──────────────────────────────────────────────────────────────────────────
 * Turns a `tracker_activity_log` row into a plain-English sentence for the
 * project History and the Latest-activity line. No server-only imports and no
 * database: the screen loads the rows (RLS-scoped) and the names/labels it
 * needs, then these helpers only shape and word them.
 *
 * {who}: the actor's display name, "Someone no longer in the group" when the
 * actor_id doesn't resolve, or "System" when actor_id is empty (migrations and
 * background jobs — an import stamps the person who ran it).
 *
 * {what}: built from entity_type, verb and diff, per the wording table in the
 * SRS/brief. In `diff`, a created row is the full new row, a deleted row the
 * full old row, and an update is `{ column: { old, new } }` for the changed
 * columns only. Bookkeeping columns are ignored; lookup keys are shown by their
 * labels; long text fields say "changed the {field}" without the text.
 */

import { formatDate, type Lookups } from './view'

// ── Row shape ───────────────────────────────────────────────────────────────

export type ActivityLogRow = {
  id: string
  actor_id: string | null
  entity_type: string
  entity_id: string
  verb: 'created' | 'updated' | 'deleted'
  diff: unknown
  created_at: string
}

/** A row ready to render: the when-line, the actor name and the sentence. */
export type HistoryItem = {
  id: string
  when: string
  who: string
  what: string
}

// ── Context the wording needs ───────────────────────────────────────────────

export type HistoryContext = {
  /** actor_id → display name (from /api/tracker/people). */
  names: Record<string, string>
  /** Lookups for showing status/category/type/source/region keys as labels. */
  lookups: Lookups
  /** Current title of a milestone/action by entity_id (updates carry only the diff). */
  titleById: Record<string, string>
  /** Current name of a contact by entity_id (contact links carry only the diff). */
  contactNameById: Record<string, string>
  /** The group's IANA time zone, e.g. 'Australia/Perth'. */
  timeZone: string
}

// ── Bookkeeping columns to ignore in a diff ─────────────────────────────────

const BOOKKEEPING = new Set([
  'created_at',
  'created_by',
  'updated_at',
  'updated_by',
  'edited_at',
  'updated_on',
])

// Long free-text fields: say "changed the {field}" without the old/new value.
const LONG_TEXT_FIELDS = new Set(['summary', 'notes', 'body', 'text'])

// Columns whose values are lookup keys → show by their label, from this list.
const LOOKUP_LIST_BY_COLUMN: Record<string, string> = {
  status: 'status',
  category: 'category',
  type: 'action_type',
  source: 'source',
  region: 'region',
}

// Friendly field names for the "changed {field}" wording.
const FIELD_LABELS: Record<string, string> = {
  due_on: 'due date',
  start_on: 'start date',
  end_on: 'end date',
  progress_pct: 'progress',
  lead_id: 'lead',
  owner_id: 'owner',
  parent_id: 'parent project',
}

// ── Public: whole-row renderers ─────────────────────────────────────────────

/** Build a renderable history item for one activity-log row. */
export function toHistoryItem(row: ActivityLogRow, ctx: HistoryContext): HistoryItem {
  return {
    id: row.id,
    when: formatInTimeZone(row.created_at, ctx.timeZone),
    who: actorName(row.actor_id, ctx.names),
    what: describeActivity(row, ctx),
  }
}

/** The actor's display name, with the two fallbacks. */
export function actorName(actorId: string | null, names: Record<string, string>): string {
  if (!actorId) return 'System'
  const name = names[actorId]
  return name && name !== '—' ? name : 'Someone no longer in the group'
}

// ── {what} ──────────────────────────────────────────────────────────────────

/** The sentence describing the change (no actor name). */
export function describeActivity(row: ActivityLogRow, ctx: HistoryContext): string {
  const diff = isObject(row.diff) ? (row.diff as Record<string, unknown>) : {}
  switch (row.entity_type) {
    case 'tracker_project_plans':
      return describePlan(row.verb, diff, ctx)
    case 'tracker_milestones':
      return describeMilestone(row, diff, ctx)
    case 'tracker_actions':
      return describeAction(row, diff, ctx)
    case 'tracker_updates':
      return describeUpdate(row.verb, diff, ctx)
    case 'tracker_plan_members':
      return describeMember(row.verb, diff, ctx)
    case 'tracker_plan_shares':
      return describeShare(row.verb, diff, ctx)
    case 'tracker_contact_plans':
      return describeContactLink(row, diff, ctx)
    case 'tracker_comments':
      return describeComment(row.verb)
    default:
      return 'made a change'
  }
}

function describePlan(verb: string, diff: Record<string, unknown>, ctx: HistoryContext): string {
  if (verb === 'created') return 'created this project'
  if (verb === 'deleted') return 'made a change'
  // Updated. archived_at set / cleared is phrased on its own.
  if ('archived_at' in diff) {
    const change = asChange(diff.archived_at)
    if (change) {
      if (change.new) return 'archived this project'
      return 'restored this project'
    }
  }
  return changedFields(diff, ctx)
}

function describeMilestone(row: ActivityLogRow, diff: Record<string, unknown>, ctx: HistoryContext): string {
  const title = milestoneOrActionTitle(row, diff, ctx)
  if (row.verb === 'created') return `added the milestone "${title}"`
  if (row.verb === 'deleted') return `deleted the milestone "${title}"`
  return `changed the milestone "${title}": ${changedFieldsBody(diff, ctx)}`
}

function describeAction(row: ActivityLogRow, diff: Record<string, unknown>, ctx: HistoryContext): string {
  const title = milestoneOrActionTitle(row, diff, ctx)
  if (row.verb === 'created') return `added the action "${title}"`
  if (row.verb === 'deleted') return `deleted the action "${title}"`

  // Updated — status transitions and due_on moves get special wording.
  if ('status' in diff) {
    const change = asChange(diff.status)
    const to = change ? String(change.new ?? '') : ''
    if (to === 'done') return `closed the action "${title}"`
    if (to === 'waiting') return `marked "${title}" as Waiting`
    if (to === 'open') return `reopened "${title}"`
  }
  if ('due_on' in diff) {
    const change = asChange(diff.due_on)
    if (change) {
      return `moved "${title}" from ${valueLabel('due_on', change.old, ctx)} to ${valueLabel('due_on', change.new, ctx)}`
    }
  }
  return `changed the action "${title}"`
}

function describeUpdate(verb: string, diff: Record<string, unknown>, ctx: HistoryContext): string {
  if (verb === 'created') {
    const source = valueLabel('source', diff.source, ctx)
    return source ? `logged an update (${source})` : 'logged an update'
  }
  if (verb === 'deleted') return 'deleted an update'
  return 'edited an update'
}

function describeMember(verb: string, diff: Record<string, unknown>, ctx: HistoryContext): string {
  const name = personName(diff.user_id, ctx)
  if (verb === 'created') return `added ${name} as a member`
  if (verb === 'deleted') return `removed ${name} as a member`
  return 'made a change'
}

function describeShare(verb: string, diff: Record<string, unknown>, ctx: HistoryContext): string {
  if (verb === 'created') {
    const name = personName(diff.user_id, ctx)
    return `gave ${name} ${shareLevelLabel(diff.level)} access`
  }
  if (verb === 'deleted') {
    const name = personName(diff.user_id, ctx)
    return `removed ${name}'s access`
  }
  // Updated.
  const name = personName(diff.user_id, ctx)
  const change = asChange(diff.level)
  const level = change ? shareLevelLabel(change.new) : shareLevelLabel(diff.level)
  return `changed ${name}'s access to ${level}`
}

function describeContactLink(row: ActivityLogRow, diff: Record<string, unknown>, ctx: HistoryContext): string {
  const contactId = String(diff.contact_id ?? '')
  const name = ctx.contactNameById[contactId] || 'a contact'
  if (row.verb === 'created') return `linked the contact ${name}`
  if (row.verb === 'deleted') return `unlinked the contact ${name}`
  return 'made a change'
}

function describeComment(verb: string): string {
  if (verb === 'created') return 'commented'
  if (verb === 'deleted') return 'deleted a comment'
  return 'edited a comment'
}

// ── Changed-field wording ────────────────────────────────────────────────────

/** "changed {field} from {old} to {new}" (several: "changed status, phase and summary"). */
function changedFields(diff: Record<string, unknown>, ctx: HistoryContext): string {
  const body = changedFieldsBody(diff, ctx)
  return body ? `changed ${body}` : 'made a change'
}

/**
 * The body after "changed ": a single field reads "{field} from {old} to {new}"
 * (or "the {field}" for long text), several fields read as a list of names.
 */
function changedFieldsBody(diff: Record<string, unknown>, ctx: HistoryContext): string {
  const cols = Object.keys(diff).filter((c) => !BOOKKEEPING.has(c) && asChange(diff[c]) !== null)
  if (cols.length === 0) return ''

  if (cols.length === 1) {
    const col = cols[0]
    if (LONG_TEXT_FIELDS.has(col)) return `the ${fieldLabel(col)}`
    const change = asChange(diff[col])!
    return `${fieldLabel(col)} from ${valueLabel(col, change.old, ctx)} to ${valueLabel(col, change.new, ctx)}`
  }

  // Several fields: list their names, e.g. "status, phase and summary".
  return joinList(cols.map(fieldLabel))
}

// ── Values and labels ────────────────────────────────────────────────────────

/** A friendly field name. */
function fieldLabel(col: string): string {
  return FIELD_LABELS[col] ?? col
}

/** Render a column value: lookup label where it applies, else a readable string. */
function valueLabel(col: string, value: unknown, ctx: HistoryContext): string {
  if (value === null || value === undefined || value === '') return '—'
  const list = LOOKUP_LIST_BY_COLUMN[col]
  if (list) {
    const key = String(value)
    return ctx.lookups[list]?.find((o) => o.key === key)?.label ?? key
  }
  if (col === 'owner_id' || col === 'lead_id' || col === 'user_id') {
    return personName(value, ctx)
  }
  if (col === 'due_on' || col === 'start_on' || col === 'end_on') {
    return formatDate(String(value)) || String(value)
  }
  if (col === 'priority') {
    const v = String(value)
    return v === 'high' ? 'High' : v === 'normal' ? 'Normal' : v
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  return String(value)
}

function personName(id: unknown, ctx: HistoryContext): string {
  if (!id) return 'someone'
  const name = ctx.names[String(id)]
  return name && name !== '—' ? name : 'someone no longer in the group'
}

function shareLevelLabel(level: unknown): string {
  const v = String(level ?? '')
  if (v === 'comment') return 'Comment'
  if (v === 'edit') return 'Edit'
  return v || '—'
}

/** For an updated milestone/action the diff carries only changed columns, so
 * read the current title by entity_id; for a delete, take it from the diff. */
function milestoneOrActionTitle(row: ActivityLogRow, diff: Record<string, unknown>, ctx: HistoryContext): string {
  if (row.verb === 'deleted') {
    const t = diff.title
    if (typeof t === 'string' && t.trim()) return t
  }
  const current = ctx.titleById[row.entity_id]
  if (current) return current
  // Fall back to a created-row title if present in the diff.
  const t = diff.title
  if (typeof t === 'string' && t.trim()) return t
  return 'Untitled'
}

// ── Diff-cell helpers ────────────────────────────────────────────────────────

type Change = { old: unknown; new: unknown }

/** A `{ old, new }` cell, or null when the value isn't shaped that way. */
function asChange(v: unknown): Change | null {
  if (isObject(v) && ('old' in (v as object) || 'new' in (v as object))) {
    const o = v as Record<string, unknown>
    return { old: o.old ?? null, new: o.new ?? null }
  }
  return null
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** "a", "a and b", "a, b and c". */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

// ── Time ─────────────────────────────────────────────────────────────────────

/** Format an ISO timestamp as "3 Jun 2026, 2:15 pm" in the given time zone. */
export function formatInTimeZone(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return ''
  const dt = new Date(iso)
  if (Number.isNaN(dt.getTime())) return iso
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).formatToParts(dt)
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
    const day = get('day')
    const month = get('month')
    const year = get('year')
    const hour = get('hour')
    const minute = get('minute')
    const ampm = (get('dayPeriod') || '').toLowerCase()
    return `${day} ${month} ${year}, ${hour}:${minute} ${ampm}`.trim()
  } catch {
    return iso
  }
}
