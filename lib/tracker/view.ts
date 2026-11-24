/**
 * Tracker view-model types and pure formatting helpers (P5).
 * ──────────────────────────────────────────────────────────────────────────
 * Client-safe: no imports of server-only modules. The screens pass in rows
 * loaded through the Supabase server client (so RLS from migration 082 has
 * already decided what the reader may see); these helpers only shape and
 * label them.
 *
 * The numbers themselves come from the database views (migration 083) —
 * tracker_v_plan_attention and tracker_v_milestone_progress — never
 * recomputed here. See lib/tracker/domain.ts for the shared rules.
 */

export type LookupRow = {
  list: string
  key: string
  label: string
  colour: string | null
  sort_order: number
  /** Shown (true) or hidden (false). Optional so older callers still work. */
  active?: boolean
}

export type LookupOption = { key: string; label: string; sort_order: number; colour: string | null; active: boolean }

/** A map from a lookup list name to its keys in sort order, with labels. */
export type Lookups = Record<string, LookupOption[]>

/**
 * Build a Lookups structure from the raw rows, sorted by sort_order.
 *
 * IMPORTANT (spec): callers must load BOTH shown and hidden values so that
 * existing records keep showing their label (via lookupLabel) even after a
 * value is hidden. Dropdowns must then populate from activeOptions(), which
 * filters to shown values only. Rows missing `active` are treated as shown.
 */
export function buildLookups(rows: LookupRow[]): Lookups {
  const out: Lookups = {}
  for (const r of rows) {
    ;(out[r.list] ??= []).push({
      key: r.key,
      label: r.label,
      sort_order: r.sort_order,
      colour: r.colour,
      active: r.active ?? true,
    })
  }
  for (const list of Object.keys(out)) {
    out[list].sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label))
  }
  return out
}

/**
 * The shown (active) values for a list, in sort order — use this for every
 * choice control (dropdown / picker). Hidden values are excluded here but
 * stay available to lookupLabel so existing records keep their labels.
 */
export function activeOptions(lookups: Lookups, list: string): { key: string; label: string }[] {
  return (lookups[list] ?? []).filter((o) => o.active).map((o) => ({ key: o.key, label: o.label }))
}

/** Label for a key in a lookup list, falling back to the raw key. */
export function lookupLabel(lookups: Lookups, list: string, key: string | null | undefined): string {
  if (!key) return ''
  return lookups[list]?.find((o) => o.key === key)?.label ?? key
}

/**
 * The shown values for a dropdown PLUS the record's own current value, even if
 * that value is now hidden. This keeps an existing record's chosen value in the
 * picker — so it still shows and isn't silently cleared on save — while other
 * records' pickers only offer the shown values. The current value is appended
 * (labelled via lookupLabel) when it isn't already among the shown options.
 */
export function optionsWithCurrent(
  lookups: Lookups,
  list: string,
  currentKey: string | null | undefined,
): { key: string; label: string }[] {
  const options = activeOptions(lookups, list)
  if (!currentKey) return options
  if (options.some((o) => o.key === currentKey)) return options
  return [...options, { key: currentKey, label: lookupLabel(lookups, list, currentKey) }]
}

// ── Status colour mapping (design spec) ─────────────────────────────────────

/**
 * A project status colour tone, from the agreed design:
 *   green  — On track, Wrapping up
 *   amber  — At risk
 *   red    — Blocked
 *   blue   — Waiting on others
 *   purple — Needs a status check
 *   grey   — Proposal / pre-contract, Finished (and anything else)
 */
export type StatusTone = 'green' | 'amber' | 'red' | 'blue' | 'purple' | 'grey'

const STATUS_TONES: Record<string, StatusTone> = {
  on_track: 'green',
  wrapping_up: 'green',
  at_risk: 'amber',
  blocked: 'red',
  waiting_on_others: 'blue',
  needs_status_check: 'purple',
  proposal_pre_contract: 'grey',
  finished: 'grey',
}

/** The colour tone for a project status key (grey for unknown/none). */
export function statusTone(statusKey: string | null | undefined): StatusTone {
  if (!statusKey) return 'grey'
  return STATUS_TONES[statusKey] ?? 'grey'
}

/** Tailwind classes for a colour-coded status label, in light and dark mode. */
export function statusLabelClasses(statusKey: string | null | undefined): string {
  switch (statusTone(statusKey)) {
    case 'green':
      return 'border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
    case 'amber':
      return 'border-transparent bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
    case 'red':
      return 'border-transparent bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
    case 'blue':
      return 'border-transparent bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
    case 'purple':
      return 'border-transparent bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300'
    default:
      return 'border-transparent bg-muted text-muted-foreground'
  }
}

// ── Attention flags → short labels (FR-2.4) ─────────────────────────────────

export type AttentionRow = {
  plan_id: string
  is_active: boolean
  status: string | null
  last_updated: string
  open_actions: number
  sub_plans: number
  next_action_id: string | null
  next_action_title: string | null
  next_action_due: string | null
  flag_status: boolean
  flag_no_open_action: boolean
  flag_overdue_action: boolean
  flag_stale: boolean
  needs_attention: boolean
}

export type AttentionLabel = { text: string; tone: 'error' | 'warning' | 'secondary' }

/**
 * Short attention-flag labels for a plan card. `today` and the status label
 * are passed in so this stays pure and uses the same "today" the views use.
 */
export function attentionLabels(
  row: AttentionRow,
  today: string,
  statusLabel: string,
): AttentionLabel[] {
  const out: AttentionLabel[] = []
  if (row.flag_overdue_action) out.push({ text: 'Overdue action', tone: 'error' })
  if (row.flag_no_open_action) out.push({ text: 'No next action', tone: 'warning' })
  if (row.flag_stale) {
    const days = daysBetweenISO(row.last_updated, today)
    out.push({ text: `No update for ${days} days`, tone: 'warning' })
  }
  if (row.flag_status && statusLabel) out.push({ text: statusLabel, tone: 'warning' })
  return out
}

/** b − a in whole days, from two 'YYYY-MM-DD' strings. */
export function daysBetweenISO(a: string, b: string): number {
  const toUtc = (d: string) => {
    const [y, m, day] = d.split('-').map(Number)
    return Date.UTC(y, m - 1, day)
  }
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000)
}

// ── Milestone progress label (FR-3.3) ───────────────────────────────────────

export type MilestoneProgressRow = {
  milestone_id: string
  plan_id: string
  status: string
  due_on: string | null
  done_actions: number
  total_actions: number
  progress_pct: number
  days_slipped: number | null
  overdue: boolean
}

/** "n of m · p%" for a milestone. */
export function milestoneProgressLabel(row: MilestoneProgressRow): string {
  return `${row.done_actions} of ${row.total_actions} · ${row.progress_pct}%`
}

// ── Dates ────────────────────────────────────────────────────────────────────

/** Format a 'YYYY-MM-DD' date for display, e.g. "3 Jun 2026". Empty for null. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d} ${months[m - 1]} ${y}`
}

/** Format an ISO timestamp as "date, time", e.g. "3 Jun 2026, 2:15 pm". */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const dt = new Date(iso)
  if (Number.isNaN(dt.getTime())) return iso
  const date = formatDate(dt.toISOString().slice(0, 10))
  let h = dt.getHours()
  const min = String(dt.getMinutes()).padStart(2, '0')
  const ampm = h < 12 ? 'am' : 'pm'
  h = h % 12
  if (h === 0) h = 12
  return `${date}, ${h}:${min} ${ampm}`
}

/** A folder string is a link only when it starts with http:// or https://. */
export function isFolderLink(folder: string | null | undefined): boolean {
  if (!folder) return false
  return /^https?:\/\//i.test(folder.trim())
}

/**
 * A short, friendly "when posted" label for a timestamp (comments). "today",
 * "yesterday", else "18 Nov" (or "18 Nov 2024" for a different year). `now`
 * lets callers pin the reference time for tests.
 */
export function relativeWhen(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return ''
  const dt = new Date(iso)
  if (Number.isNaN(dt.getTime())) return iso
  const startOfDay = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  const dayDiff = Math.round((startOfDay(now) - startOfDay(dt)) / 86_400_000)
  if (dayDiff === 0) return 'today'
  if (dayDiff === 1) return 'yesterday'
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const sameYear = dt.getFullYear() === now.getFullYear()
  return sameYear
    ? `${dt.getDate()} ${months[dt.getMonth()]}`
    : `${dt.getDate()} ${months[dt.getMonth()]} ${dt.getFullYear()}`
}
