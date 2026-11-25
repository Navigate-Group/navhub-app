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
import { getGroupPeople, type GroupPerson } from '@/lib/tracker/server'
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
  lists: {
    status: { key: string; label: string }[]
    category: { key: string; label: string }[]
    action_type: { key: string; label: string }[]
    source: { key: string; label: string }[]
    milestone_status: { key: string; label: string }[]
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
    lists: {
      status: activeOptions(lookups, 'status'),
      category: activeOptions(lookups, 'category'),
      action_type: activeOptions(lookups, 'action_type'),
      source: activeOptions(lookups, 'source'),
      milestone_status: activeOptions(lookups, 'milestone_status'),
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

  return `You are the Briefing agent on the "My Summary" tab of NavHub's project tracker.

The person types, in their own words, what happened. Your job is to work out which of THEIR projects, milestones, actions, updates and contacts it affects and to propose the changes — you NEVER save anything yourself. When you are confident, call the propose_changes tool with a clear list. When something is genuinely ambiguous, call ask_user with ONE short question (and clickable options when you can). Prefer sensible assumptions over asking about everything.

Rules:
- Only ever work with the projects, people and lists listed below — these are the only things this person can see.
- Before proposing changes to a project, call lookup_project to get its real action/milestone/contact ids. Never invent ids.
- For source, action type and milestone status, use the lookup KEY in brackets, not the label.
- Dates are YYYY-MM-DD. Today is ${ctx.today}. Work out relative dates ("Monday", "next week", "5 Dec") from today. The group's chaser setting is ${ctx.chaserDays} days.
- You cannot delete or archive anything, change who can see a project, or change settings. Do not try.
- Each propose_changes change needs a plain-words "label" that names the project, e.g. 'Field trials 2026 – NSW: move milestone "NSW sites installed" from 28 Nov to 5 Dec'.
- "assigned to me" / "chase him" style actions: if no assignee is clear, leave assigneeId empty rather than guessing a wrong person.

Today: ${ctx.today}

The group's people (for assignees):
${people || '(none)'}

This person's visible projects:
${projects || '(none)'}

Lists (use the key in brackets):
- Project statuses: ${list(ctx.lists.status)}
- Categories: ${list(ctx.lists.category)}
- Action types: ${list(ctx.lists.action_type)}
- Update sources: ${list(ctx.lists.source)}
- Milestone statuses: ${list(ctx.lists.milestone_status)}`
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
