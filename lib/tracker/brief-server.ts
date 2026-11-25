/**
 * Briefing agent — server-only helpers.
 * ──────────────────────────────────────────────────────────────────────────
 * Builds the model's context from ONLY what the signed-in person can see
 * (through the Supabase server client, so RLS from migration 082 applies —
 * Staff see only their own projects since migration 086), resolves the
 * Anthropic key in NavHub's usual order (group → platform default → env), and
 * provides the `lookup_project` tool handler the conversation route calls.
 *
 * Nothing here writes to the database. Applying is handled separately in
 * app/api/tracker/brief/apply/route.ts, which reuses the existing tracker
 * routes' logic through the same server client.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/encryption'
import { getGroupPeople, isEditor, type GroupPerson } from '@/lib/tracker/server'
import { buildLookups, activeOptions } from '@/lib/tracker/view'
import type { LookupRow } from '@/lib/tracker/view'

export type BriefProject = {
  id: string
  name: string
  client: string | null
  status: string | null
  leadId: string | null
}

export type BriefContext = {
  today: string
  chaserDays: number
  people: GroupPerson[]
  projects: BriefProject[]
  /** True when the person is a Manager/Group Owner and may create projects. */
  canCreateProject: boolean
  lists: {
    status: { key: string; label: string }[]
    category: { key: string; label: string }[]
    action_type: { key: string; label: string }[]
    source: { key: string; label: string }[]
    milestone_status: { key: string; label: string }[]
    region: { key: string; label: string }[]
  }
}

/**
 * Load the agent's context as the signed-in person. Only projects they may read
 * are returned (RLS-scoped). The group's people and lists are added so the model
 * can resolve assignees, sources, action types and milestone statuses.
 */
export async function buildBriefContext(
  supabase: SupabaseClient,
  groupId: string,
): Promise<BriefContext> {
  const [
    { data: todayVal },
    { data: settingsRow },
    { data: lookupRows },
    { data: planRows },
    people,
    canCreateProject,
  ] = await Promise.all([
    supabase.rpc('tracker_today', { p_group_id: groupId }),
    supabase.from('tracker_settings').select('chaser_days').eq('group_id', groupId).maybeSingle(),
    supabase
      .from('tracker_lookups')
      .select('list, key, label, colour, sort_order, active')
      .eq('group_id', groupId),
    supabase
      .from('tracker_project_plans')
      .select('id, name, client, status, lead_id, archived_at')
      .eq('group_id', groupId),
    getGroupPeople(supabase, groupId),
    isEditor(supabase, groupId),
  ])

  const today = typeof todayVal === 'string' ? todayVal : new Date().toISOString().slice(0, 10)
  const chaserDays = typeof settingsRow?.chaser_days === 'number' ? settingsRow.chaser_days : 5
  const lookups = buildLookups((lookupRows ?? []) as LookupRow[])

  const projects: BriefProject[] = (planRows ?? [])
    .filter((p) => !p.archived_at)
    .map((p) => ({
      id: p.id as string,
      name: (p.name as string) ?? '',
      client: (p.client as string | null) ?? null,
      status: (p.status as string | null) ?? null,
      leadId: (p.lead_id as string | null) ?? null,
    }))

  return {
    today,
    chaserDays,
    people: people ?? [],
    projects,
    canCreateProject: canCreateProject === true,
    lists: {
      status: activeOptions(lookups, 'status'),
      category: activeOptions(lookups, 'category'),
      action_type: activeOptions(lookups, 'action_type'),
      source: activeOptions(lookups, 'source'),
      milestone_status: activeOptions(lookups, 'milestone_status'),
      region: activeOptions(lookups, 'region'),
    },
  }
}

export type ProjectDetail = {
  id: string
  name: string
  found: boolean
  actions: {
    id: string
    title: string
    type: string | null
    status: string
    dueOn: string | null
    assigneeId: string | null
    milestoneId: string | null
  }[]
  milestones: {
    id: string
    title: string
    status: string | null
    dueOn: string | null
    progressPct: number | null
  }[]
  recentUpdates: { date: string; source: string | null; text: string }[]
  contacts: { id: string; name: string; org: string | null }[]
}

/**
 * The `lookup_project` tool handler: a project's open actions, milestones,
 * recent updates and linked contacts — read as the signed-in person, so an id
 * they can't see returns `found: false` with empty lists (never other people's
 * data). Open actions means status open or waiting (DATA_MODEL).
 */
export async function lookupProject(
  supabase: SupabaseClient,
  groupId: string,
  projectId: string,
): Promise<ProjectDetail> {
  const { data: plan } = await supabase
    .from('tracker_project_plans')
    .select('id, name')
    .eq('group_id', groupId)
    .eq('id', projectId)
    .maybeSingle()

  if (!plan) {
    return {
      id: projectId,
      name: '',
      found: false,
      actions: [],
      milestones: [],
      recentUpdates: [],
      contacts: [],
    }
  }

  const [{ data: actionRows }, { data: milestoneRows }, { data: updateRows }, { data: contactLinks }] =
    await Promise.all([
      supabase
        .from('tracker_actions')
        .select('id, title, type, status, due_on, assignee_id, milestone_id, archived_at')
        .eq('group_id', groupId)
        .eq('plan_id', projectId)
        .in('status', ['open', 'waiting']),
      supabase
        .from('tracker_milestones')
        .select('id, title, status, due_on, progress_pct, archived_at')
        .eq('group_id', groupId)
        .eq('plan_id', projectId),
      supabase
        .from('tracker_updates')
        .select('date, source, text')
        .eq('group_id', groupId)
        .eq('plan_id', projectId)
        .order('date', { ascending: false })
        .limit(5),
      supabase
        .from('tracker_contact_plans')
        .select('contact_id, tracker_contacts(id, name, org)')
        .eq('group_id', groupId)
        .eq('plan_id', projectId),
    ])

  type ContactLinkRow = {
    contact_id: string
    tracker_contacts: { id: string; name: string; org: string | null } | { id: string; name: string; org: string | null }[] | null
  }

  const contacts = ((contactLinks ?? []) as ContactLinkRow[]).map((r) => {
    const c = Array.isArray(r.tracker_contacts) ? r.tracker_contacts[0] : r.tracker_contacts
    return { id: (c?.id as string) ?? r.contact_id, name: (c?.name as string) ?? '', org: (c?.org as string | null) ?? null }
  })

  return {
    id: projectId,
    name: (plan.name as string) ?? '',
    found: true,
    actions: (actionRows ?? [])
      .filter((a) => !a.archived_at)
      .map((a) => ({
        id: a.id as string,
        title: (a.title as string) ?? '',
        type: (a.type as string | null) ?? null,
        status: (a.status as string) ?? 'open',
        dueOn: (a.due_on as string | null) ?? null,
        assigneeId: (a.assignee_id as string | null) ?? null,
        milestoneId: (a.milestone_id as string | null) ?? null,
      })),
    milestones: (milestoneRows ?? [])
      .filter((m) => !m.archived_at)
      .map((m) => ({
        id: m.id as string,
        title: (m.title as string) ?? '',
        status: (m.status as string | null) ?? null,
        dueOn: (m.due_on as string | null) ?? null,
        progressPct: (m.progress_pct as number | null) ?? null,
      })),
    recentUpdates: (updateRows ?? []).map((u) => ({
      date: (u.date as string) ?? '',
      source: (u.source as string | null) ?? null,
      text: (u.text as string) ?? '',
    })),
    contacts,
  }
}

export type OpenItemsResult = {
  today: string
  actions: {
    id: string
    title: string
    status: string
    dueOn: string | null
    projectId: string
    projectName: string
    overdue: boolean
  }[]
  milestones: {
    id: string
    title: string
    status: string | null
    dueOn: string | null
    projectId: string
    projectName: string
    overdue: boolean
  }[]
}

/**
 * The `list_open_items` tool handler (read-only, as the signed-in person).
 * Lists open/overdue actions (status open or waiting) and non-completed
 * milestones with a due date in the given range, across the person's visible
 * projects (or one project). RLS (082/086) scopes the rows to what the person
 * can see. Dates are 'YYYY-MM-DD'.
 */
export async function listOpenItems(
  supabase: SupabaseClient,
  groupId: string,
  today: string,
  opts: { projectId?: string; from?: string; to?: string; overdueOnly?: boolean },
): Promise<OpenItemsResult> {
  const ISO = /^\d{4}-\d{2}-\d{2}$/
  const from = opts.from && ISO.test(opts.from) ? opts.from : undefined
  // overdueOnly caps the upper bound at the day before today.
  let to = opts.to && ISO.test(opts.to) ? opts.to : undefined
  if (opts.overdueOnly) {
    const beforeToday = today // items strictly before today are overdue
    to = to && to < beforeToday ? to : beforeToday
  }

  // Names of the person's visible (non-archived) projects, for labels and to
  // optionally limit to one project.
  const { data: planRows } = await supabase
    .from('tracker_project_plans')
    .select('id, name, archived_at')
    .eq('group_id', groupId)
  const nameById = new Map<string, string>()
  for (const p of planRows ?? []) {
    if (!p.archived_at) nameById.set(p.id as string, (p.name as string) ?? '')
  }
  const limitTo = opts.projectId && nameById.has(opts.projectId) ? opts.projectId : undefined

  let actionsQ = supabase
    .from('tracker_actions')
    .select('id, title, status, due_on, plan_id, archived_at')
    .eq('group_id', groupId)
    .in('status', ['open', 'waiting'])
    .not('due_on', 'is', null)
  let milestonesQ = supabase
    .from('tracker_milestones')
    .select('id, title, status, due_on, plan_id, archived_at')
    .eq('group_id', groupId)
    .not('status', 'in', '("completed","cancelled","done")')
    .not('due_on', 'is', null)

  if (limitTo) {
    actionsQ = actionsQ.eq('plan_id', limitTo)
    milestonesQ = milestonesQ.eq('plan_id', limitTo)
  }
  if (from) {
    actionsQ = actionsQ.gte('due_on', from)
    milestonesQ = milestonesQ.gte('due_on', from)
  }
  if (opts.overdueOnly) {
    actionsQ = actionsQ.lt('due_on', today)
    milestonesQ = milestonesQ.lt('due_on', today)
  } else if (to) {
    actionsQ = actionsQ.lte('due_on', to)
    milestonesQ = milestonesQ.lte('due_on', to)
  }

  const [{ data: actionRows }, { data: milestoneRows }] = await Promise.all([actionsQ, milestonesQ])

  const actions = (actionRows ?? [])
    .filter((a) => !a.archived_at && nameById.has(a.plan_id as string))
    .map((a) => {
      const due = (a.due_on as string | null) ?? null
      return {
        id: a.id as string,
        title: (a.title as string) ?? '',
        status: (a.status as string) ?? 'open',
        dueOn: due,
        projectId: a.plan_id as string,
        projectName: nameById.get(a.plan_id as string) ?? '',
        overdue: due !== null && due < today,
      }
    })
  const milestones = (milestoneRows ?? [])
    .filter((m) => !m.archived_at && nameById.has(m.plan_id as string))
    .map((m) => {
      const due = (m.due_on as string | null) ?? null
      return {
        id: m.id as string,
        title: (m.title as string) ?? '',
        status: (m.status as string | null) ?? null,
        dueOn: due,
        projectId: m.plan_id as string,
        projectName: nameById.get(m.plan_id as string) ?? '',
        overdue: due !== null && due < today,
      }
    })

  return { today, actions, milestones }
}

export type ContactMatch = {
  id: string
  name: string
  org: string | null
  role: string | null
  phone: string | null
  email: string | null
  lastContact: string | null
  projects: { id: string; name: string }[]
}

/**
 * The `find_contact` tool handler (read-only, as the signed-in person). Returns
 * contacts whose name matches (case-insensitive partial), each with their
 * linked visible projects and last-contact date. RLS scopes to what the person
 * can see.
 */
export async function findContact(
  supabase: SupabaseClient,
  groupId: string,
  name: string,
): Promise<{ contacts: ContactMatch[] }> {
  const needle = name.trim()
  if (!needle) return { contacts: [] }

  const { data: contactRows } = await supabase
    .from('tracker_contacts')
    .select('id, name, org, role, phone, email, last_contact, archived_at')
    .eq('group_id', groupId)
    .ilike('name', `%${needle}%`)
    .limit(10)

  const matches = (contactRows ?? []).filter((c) => !c.archived_at)
  if (matches.length === 0) return { contacts: [] }

  const ids = matches.map((c) => c.id as string)
  const { data: linkRows } = await supabase
    .from('tracker_contact_plans')
    .select('contact_id, tracker_project_plans(id, name, archived_at)')
    .eq('group_id', groupId)
    .in('contact_id', ids)

  type LinkRow = {
    contact_id: string
    tracker_project_plans:
      | { id: string; name: string; archived_at: string | null }
      | { id: string; name: string; archived_at: string | null }[]
      | null
  }
  const projectsByContact = new Map<string, { id: string; name: string }[]>()
  for (const r of (linkRows ?? []) as LinkRow[]) {
    const p = Array.isArray(r.tracker_project_plans) ? r.tracker_project_plans[0] : r.tracker_project_plans
    if (!p || p.archived_at) continue
    const list = projectsByContact.get(r.contact_id) ?? []
    list.push({ id: p.id, name: p.name ?? '' })
    projectsByContact.set(r.contact_id, list)
  }

  return {
    contacts: matches.map((c) => ({
      id: c.id as string,
      name: (c.name as string) ?? '',
      org: (c.org as string | null) ?? null,
      role: (c.role as string | null) ?? null,
      phone: (c.phone as string | null) ?? null,
      email: (c.email as string | null) ?? null,
      lastContact: (c.last_contact as string | null) ?? null,
      projects: projectsByContact.get(c.id as string) ?? [],
    })),
  }
}

/**
 * Build the system prompt. Lists the person's visible projects, the group's
 * people and lists, today and the chaser setting. Keeps everything the model
 * sees within the person's need-to-know.
 */
export function buildBriefSystemPrompt(ctx: BriefContext): string {
  const people = ctx.people
    .map((p) => `- ${p.name || '(unnamed)'} [id ${p.id}]${p.role ? ` — ${p.role}` : ''}`)
    .join('\n')
  const projects = ctx.projects
    .map(
      (p) =>
        `- ${p.name} [id ${p.id}]${p.client ? ` · client ${p.client}` : ''}${p.status ? ` · status ${p.status}` : ''}`,
    )
    .join('\n')
  const list = (xs: { key: string; label: string }[]) =>
    xs.map((x) => `${x.label} [${x.key}]`).join(', ') || '(none)'

  const createProjectLine = ctx.canCreateProject
    ? '- You MAY propose create_project (this person is a Manager/Group Owner). The new project is owned by them. The parent, if named, MUST be an EXISTING project from the list below — never invent one. If the parent they name is not listed, do NOT propose the project: say the parent doesn\'t exist and suggest creating it first (as its own project, or in Settings → Parent projects). New list values (e.g. a new region) are not created here — say they can be added in Settings → Lists.'
    : '- Do NOT propose create_project — this person is not a Manager or Group Owner and cannot create projects.'

  return `You are the Briefing agent on the "My Summary" tab of NavHub's project tracker.

The person types, in their own words, either what happened (which you turn into proposed changes) or a QUESTION (which you answer in plain words, changing nothing). Every turn MUST end in a tool call: propose_changes (a confirm card), ask_user (a question with options), or answer (a plain-text answer). Never end a turn with only a statement of what you "will" do — always finish with one of these tools. When you are confident about changes, call propose_changes. When the person is asking a question, call answer. When something is genuinely ambiguous, call ask_user with ONE short question (and clickable options when you can). Prefer sensible assumptions over asking about everything.

Rules:
- Only ever work with the projects, people and lists listed below — these are the only things this person can see.
- Before proposing changes to a project, call lookup_project to get its real action/milestone/contact ids. Never invent ids.
- For source, action type, milestone status, project status, category and region, use the lookup KEY in brackets, not the label.
- Dates are YYYY-MM-DD. Today is ${ctx.today}. Work out relative dates ("Monday", "next week", "5 Dec") from today. The group's chaser setting is ${ctx.chaserDays} days.
- You cannot delete or archive anything, change who can see a project, or change settings. Do not try.
- Each propose_changes change needs a plain-words "label" that names the project, e.g. 'Field trials 2026 – NSW: move milestone "NSW sites installed" from 28 Nov to 5 Dec'.
- "assigned to me" / "chase him" style actions: if no assignee is clear, leave assigneeId empty rather than guessing a wrong person.
- "progress" or "status" WITHOUT a named milestone means the PROJECT'S own progress or status — use update_plan (progressPct 0–100). Only use update_milestone when a specific milestone is named. If it's genuinely unclear (the project has milestones and they didn't say which), ask_user with options: "The project" and each milestone by name.
- Setting a milestone's progress switches it to "set by hand"; note that on the label, e.g. '… progress → 50% (set by hand)'.
- update_contact changes ONLY the fields the person mentioned (phone, email, organisation, role, notes) — omit the rest.
- Questions like "what's overdue on NSW?", "what's due this week?", "when did we last speak to Pat?" or "who's leading the irrigation grant?" are ANSWERS, not changes: use list_open_items / find_contact / lookup_project to get the facts, then call answer. Never propose or save for a question. If the person then asks for a change, propose it as usual.
${createProjectLine}

Today: ${ctx.today}

The group's people (for assignees, leads and members):
${people || '(none)'}

This person's visible projects (also the only valid parents for a new project):
${projects || '(none)'}

Lists (use the key in brackets):
- Project statuses: ${list(ctx.lists.status)}
- Categories: ${list(ctx.lists.category)}
- Action types: ${list(ctx.lists.action_type)}
- Update sources: ${list(ctx.lists.source)}
- Milestone statuses: ${list(ctx.lists.milestone_status)}
- Regions: ${list(ctx.lists.region)}`
}

/**
 * Resolve the Anthropic API key in NavHub's usual order: the group's provider
 * key, then the platform (superadmin) default, then the ANTHROPIC_API_KEY env
 * var. Returns undefined when none is configured. Mirrors the NavHub assistant
 * chat route so both agents pick the key the same way.
 */
export async function resolveAnthropicKey(groupId: string): Promise<string | undefined> {
  const admin = createAdminClient()
  let apiKey: string | undefined

  const { data: groupProvRow } = await admin
    .from('group_provider_configs')
    .select('api_key_encrypted')
    .eq('group_id', groupId)
    .eq('provider', 'anthropic')
    .eq('is_active', true)
    .maybeSingle()
  if (groupProvRow) {
    try {
      apiKey = decrypt(groupProvRow.api_key_encrypted as string)
    } catch {
      /* keep undefined */
    }
  }

  if (!apiKey) {
    const { data: superRow } = await admin
      .from('superadmin_provider_configs')
      .select('api_key_encrypted')
      .eq('provider', 'anthropic')
      .eq('is_active', true)
      .maybeSingle()
    if (superRow) {
      try {
        apiKey = decrypt(superRow.api_key_encrypted as string)
      } catch {
        /* keep undefined */
      }
    }
  }

  if (!apiKey) apiKey = process.env.ANTHROPIC_API_KEY
  return apiKey
}
