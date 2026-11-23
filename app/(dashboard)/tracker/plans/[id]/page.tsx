import { notFound, redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import Link from 'next/link'
import { getTrackerContext, isEditor, canAccess, getGroupPeople, nameMap, getTrackerHeaderData } from '@/lib/tracker/server'
import TrackerHeader from '@/components/tracker/TrackerHeader'
import {
  buildLookups,
  lookupLabel,
  formatDate,
  formatDateTime,
  isFolderLink,
  type LookupRow,
  type MilestoneProgressRow,
} from '@/lib/tracker/view'
import { Badge } from '@/components/ui/badge'
import PlanStatusSelect from '@/components/tracker/PlanStatusSelect'
import StatusLabel from '@/components/tracker/StatusLabel'
import LogUpdateForm from '@/components/tracker/LogUpdateForm'
import PlanActions from '@/components/tracker/PlanActions'
import PlanHistory from '@/components/tracker/PlanHistory'
import MilestonesSection, { type MilestoneItem } from '@/components/tracker/MilestonesSection'
import ActionsSection, { type ActionItem } from '@/components/tracker/ActionsSection'
import CommentsSection, { type CommentItem } from '@/components/tracker/CommentsSection'
import ContactsSection, { type ContactDetail } from '@/components/tracker/ContactsSection'
import { cn } from '@/lib/utils'
import {
  toHistoryItem,
  type ActivityLogRow,
  type HistoryContext,
} from '@/lib/tracker/history'
import { DEFAULT_SETTINGS } from '@/lib/tracker/domain'

export const dynamic = 'force-dynamic'

export default async function PlanDetailPage({ params }: { params: { id: string } }) {
  noStore()

  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')
  const { supabase, userId, groupId } = ctx
  const planId = params.id

  const { data: plan } = await supabase
    .from('tracker_project_plans')
    .select('*')
    .eq('id', planId)
    .maybeSingle()

  if (!plan) notFound()

  const [editor, canEdit, canComment, header] = await Promise.all([
    isEditor(supabase, groupId),
    canAccess(supabase, planId, 'edit'),
    canAccess(supabase, planId, 'comment'),
    getTrackerHeaderData(ctx),
  ])
  const isOwner = plan.owner_id === userId

  // Lookups for labels.
  const { data: lookupRows } = await supabase
    .from('tracker_lookups')
    .select('list, key, label, colour, sort_order')
    .eq('group_id', groupId)
    .eq('active', true)
  const lookups = buildLookups((lookupRows ?? []) as LookupRow[])

  // People names for "by {name}" + owner/lead/members.
  const people = (await getGroupPeople(supabase, groupId)) ?? []
  const names = nameMap(people)

  // Sub-projects.
  const { data: subPlans } = await supabase
    .from('tracker_project_plans')
    .select('id, name, region, status')
    .eq('group_id', groupId)
    .eq('parent_id', planId)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })

  // Milestones + progress.
  const { data: milestones } = await supabase
    .from('tracker_milestones')
    .select('id, title, description, owner_id, status, health, start_on, due_on, baseline_due_on, priority, progress_mode, progress_pct, sort_order')
    .eq('group_id', groupId)
    .eq('plan_id', planId)
    .is('archived_at', null)
    .order('sort_order', { ascending: true })
  const { data: mProgress } = await supabase
    .from('tracker_v_milestone_progress')
    .select('milestone_id, status, due_on, done_actions, total_actions, progress_pct, days_slipped, overdue')
    .eq('plan_id', planId)
  const progressById = new Map<string, MilestoneProgressRow>()
  for (const r of (mProgress ?? []) as unknown as MilestoneProgressRow[]) progressById.set(r.milestone_id, r)

  // Actions (open first, then done).
  const { data: actions } = await supabase
    .from('tracker_actions')
    .select('id, title, type, who, assignee_id, due_on, status, priority, milestone_id, contact_id, notes, waiting_since')
    .eq('group_id', groupId)
    .eq('plan_id', planId)
    .is('archived_at', null)
  const sortedActions = [...(actions ?? [])].sort((a, b) => {
    const rank = (s: string) => (s === 'done' ? 1 : 0)
    return rank(a.status as string) - rank(b.status as string)
  })

  // Update log (handover first, then newest first).
  const { data: updates } = await supabase
    .from('tracker_updates')
    .select('id, kind, date, source, text, author_id')
    .eq('group_id', groupId)
    .eq('plan_id', planId)
    .order('date', { ascending: false })
  const sortedUpdates = [...(updates ?? [])].sort((a, b) => {
    const rank = (k: string) => (k === 'handover' ? 0 : 1)
    const r = rank(a.kind as string) - rank(b.kind as string)
    if (r !== 0) return r
    return (b.date as string).localeCompare(a.date as string)
  })

  // Contacts linked to the plan (full details for the side box and the action
  // Contact picker).
  const { data: contactLinks } = await supabase
    .from('tracker_contact_plans')
    .select('contact:tracker_contacts(id, name, org, role, phone, email, notes, last_contact)')
    .eq('group_id', groupId)
    .eq('plan_id', planId)
  const contacts: ContactDetail[] = ((contactLinks ?? []) as unknown as { contact: ContactDetail | ContactDetail[] | null }[])
    .map((c) => (Array.isArray(c.contact) ? c.contact[0] ?? null : c.contact))
    .filter((c): c is ContactDetail => c != null)
    .sort((a, b) => a.name.localeCompare(b.name))
  const linkedIds = new Set(contacts.map((c) => c.id))

  // Group contacts not yet linked to this plan (for "link an existing one").
  // Only loaded for people who can edit (they are the only ones who can link).
  let linkableContacts: { id: string; name: string; org: string | null; role: string | null }[] = []
  if (canEdit) {
    const { data: allContacts } = await supabase
      .from('tracker_contacts')
      .select('id, name, org, role')
      .eq('group_id', groupId)
      .is('archived_at', null)
      .order('name', { ascending: true })
    linkableContacts = ((allContacts ?? []) as { id: string; name: string; org: string | null; role: string | null }[])
      .filter((c) => !linkedIds.has(c.id))
  }

  // Project comments (not removed), oldest first so the newest sits at the
  // bottom. RLS scopes the read to group members.
  const { data: commentRows } = await supabase
    .from('tracker_comments')
    .select('id, author_id, body, created_at, edited_at')
    .eq('plan_id', planId)
    .eq('entity_type', 'plan')
    .is('deleted_at', null)
    .order('created_at', { ascending: true })

  // Members (lead/member rows). The plan's own lead_id/owner_id are shown too.
  const { data: members } = await supabase
    .from('tracker_plan_members')
    .select('user_id, role')
    .eq('plan_id', planId)

  // Today in the group's time zone (FR-1.6 fix): the Log update form must
  // default to the group's today, not the UTC date (between midnight and 8 am
  // Perth the UTC date is still yesterday). Same helper the list page uses.
  const { data: todayVal } = await supabase.rpc('tracker_today', { p_group_id: groupId })
  const today = typeof todayVal === 'string' ? todayVal : new Date().toISOString().slice(0, 10)

  // Group time zone (for History timestamps) and chaser days (for the Waiting
  // quick button and "Waiting N days" red state). Defaults when unset.
  const { data: settingsRow } = await supabase
    .from('tracker_settings')
    .select('time_zone, chaser_days')
    .eq('group_id', groupId)
    .maybeSingle()
  const timeZone = (settingsRow?.time_zone as string | null) ?? DEFAULT_SETTINGS.timeZone
  const chaserDays =
    typeof settingsRow?.chaser_days === 'number' ? (settingsRow.chaser_days as number) : DEFAULT_SETTINGS.chaserDays

  // Activity log for this plan (newest first) — the Latest-activity line and
  // the History card. RLS scopes this to what the reader may see.
  const { data: activityRows } = await supabase
    .from('tracker_activity_log')
    .select('id, actor_id, entity_type, entity_id, verb, diff, created_at')
    .eq('plan_id', planId)
    .order('created_at', { ascending: false })

  // Current milestone/action titles (incl. archived) so an update's sentence can
  // name the item — the diff only carries the changed columns.
  const [{ data: allMilestones }, { data: allActions }] = await Promise.all([
    supabase.from('tracker_milestones').select('id, title').eq('plan_id', planId),
    supabase.from('tracker_actions').select('id, title').eq('plan_id', planId),
  ])
  const titleById: Record<string, string> = {}
  for (const m of allMilestones ?? []) titleById[m.id as string] = (m.title as string) ?? ''
  for (const a of allActions ?? []) titleById[a.id as string] = (a.title as string) ?? ''
  const contactNameById: Record<string, string> = {}
  for (const c of contacts) contactNameById[c.id] = c.name

  const historyCtx: HistoryContext = { names, lookups, titleById, contactNameById, timeZone }
  const historyItems = ((activityRows ?? []) as unknown as ActivityLogRow[]).map((r) =>
    toHistoryItem(r, historyCtx),
  )
  const latestActivity = historyItems[0] ?? null

  const sourceOptions = (lookups.source ?? []).map((s) => ({ key: s.key, label: s.label }))
  const statusOptions = (lookups.status ?? []).map((s) => ({ key: s.key, label: s.label }))

  // ── Milestone / action view-models for the editable sections (P6) ──────────
  const peopleOptions = people.map((p) => ({ id: p.id, name: p.name || '—' }))
  const milestoneStatusOptions = (lookups.milestone_status ?? []).map((s) => ({ key: s.key, label: s.label }))
  const actionTypeOptions = (lookups.action_type ?? []).map((s) => ({ key: s.key, label: s.label }))
  const priorityOptions = [
    { key: 'normal', label: 'Normal' },
    { key: 'high', label: 'High' },
  ]
  const milestoneOptions = (milestones ?? []).map((m) => ({ id: m.id as string, title: m.title as string }))
  const contactOptions = contacts.map((c) => ({ id: c.id, name: c.name }))

  const milestoneItems: MilestoneItem[] = (milestones ?? []).map((m) => {
    const p = progressById.get(m.id as string)
    const slipped = p && p.days_slipped != null && (p.days_slipped as number) > 0 ? (p.days_slipped as number) : 0
    return {
      id: m.id as string,
      title: m.title as string,
      description: (m.description as string | null) ?? null,
      owner_id: (m.owner_id as string | null) ?? null,
      status: (m.status as string) ?? 'backlog',
      health: (m.health as string | null) ?? null,
      start_on: (m.start_on as string | null) ?? null,
      due_on: (m.due_on as string | null) ?? null,
      baseline_due_on: (m.baseline_due_on as string | null) ?? null,
      priority: (m.priority as string | null) ?? null,
      progress_mode: ((m.progress_mode as string) === 'from_actions' ? 'from_actions' : 'manual'),
      progress_pct: (m.progress_pct as number) ?? 0,
      doneActions: p?.done_actions ?? 0,
      totalActions: p?.total_actions ?? 0,
      viewPct: p?.progress_pct ?? 0,
      daysSlipped: slipped,
      overdue: p?.overdue ?? false,
      statusLabel: lookupLabel(lookups, 'milestone_status', m.status as string),
      // Only the milestone's owner or a Manager / Group Owner may move the
      // baseline (the DB enforces too — guard in 085).
      canEditBaseline: editor || (m.owner_id as string | null) === userId,
    }
  })

  const actionItems: ActionItem[] = sortedActions.map((a) => ({
    id: a.id as string,
    title: a.title as string,
    type: (a.type as string | null) ?? null,
    who: (a.who as string | null) ?? null,
    assignee_id: (a.assignee_id as string | null) ?? null,
    due_on: (a.due_on as string | null) ?? null,
    status: (a.status as string) ?? 'open',
    priority: (a.priority as string | null) ?? null,
    milestone_id: (a.milestone_id as string | null) ?? null,
    contact_id: (a.contact_id as string | null) ?? null,
    notes: (a.notes as string | null) ?? null,
    waiting_since: (a.waiting_since as string | null) ?? null,
    typeLabel: lookupLabel(lookups, 'action_type', a.type as string | null),
    assigneeName: a.assignee_id ? (names[a.assignee_id as string] || null) : null,
    contactName: a.contact_id ? (contactNameById[a.contact_id as string] || null) : null,
    // The quick buttons are for anyone with edit access or the action's own
    // assignee (even without project access). The DB enforces too.
    canQuick: canEdit || (a.assignee_id as string | null) === userId,
  }))

  // Comment view-models. The author edits / deletes their own; Managers / Group
  // Owners (editor) can also delete anyone's. The database is the guard.
  const commentItems: CommentItem[] = ((commentRows ?? []) as {
    id: string
    author_id: string | null
    body: string
    created_at: string
    edited_at: string | null
  }[]).map((c) => {
    const mine = c.author_id === userId
    return {
      id: c.id,
      body: c.body,
      authorName: c.author_id ? (names[c.author_id] || 'Someone no longer in the group') : 'System',
      createdAt: c.created_at,
      edited: c.edited_at != null,
      canEdit: mine && canComment,
      canDelete: mine ? canComment : editor,
    }
  })
  // Anyone with Comment or Edit access (and all Managers / Group Owners) can post.
  const canPostComment = canComment

  const lastUpdatedBy = plan.updated_by ? names[plan.updated_by as string] : null

  const categoryLabel = lookupLabel(lookups, 'category', plan.category as string | null)
  const showActions = canEdit || editor || isOwner

  return (
    <div className="space-y-6">
      {/* Group name → page title + buttons → tabs (design spec) */}
      <TrackerHeader
        groupName={header.groupName}
        title={plan.name as string}
        showSettings={header.showSettings}
        actions={
          showActions ? (
            <PlanActions
              planId={planId}
              archived={plan.archived_at !== null}
              canEdit={canEdit}
              isEditor={editor}
              isOwner={isOwner}
            />
          ) : (
            <span className="text-sm text-muted-foreground">Read only</span>
          )
        }
      />

      {/* ── Top section ──────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Link href="/tracker/plans" className="hover:underline">Projects</Link>
          <span>›</span>
          {categoryLabel && (
            <>
              <span>{categoryLabel}</span>
              <span>›</span>
            </>
          )}
          <span className="truncate">{plan.name as string}</span>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Status:</span>
          {canEdit ? (
            <PlanStatusSelect
              planId={planId}
              current={(plan.status as string | null) ?? ''}
              options={statusOptions}
            />
          ) : (
            <StatusLabel
              statusKey={plan.status as string | null}
              label={lookupLabel(lookups, 'status', plan.status as string) || '—'}
            />
          )}
        </div>

        {/* One grey metadata line */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          {categoryLabel && <span>{categoryLabel}</span>}
          {plan.client && <span>· {plan.client as string}</span>}
          {plan.phase && <span>· {plan.phase as string}</span>}
          {plan.region && <span>· {lookupLabel(lookups, 'region', plan.region as string)}</span>}
          <span>· {plan.priority === 'high' ? 'High priority' : 'Normal priority'}</span>
          <span>· {(plan.progress_pct as number) ?? 0}% complete</span>
        </div>

        <p className="text-xs text-muted-foreground">
          Last updated by {lastUpdatedBy || '—'} · {formatDateTime(plan.updated_at as string)}
        </p>
        {latestActivity && (
          <p className="text-xs text-muted-foreground">
            Latest activity: {latestActivity.who} {latestActivity.what} · {latestActivity.when}
          </p>
        )}
      </div>

      {/* ── Two-column layout ────────────────────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Wide column */}
        <div className="space-y-6 lg:col-span-2">
          {/* Summary and folder */}
          {(plan.summary || plan.folder) && (
            <Section title="Summary">
              {plan.summary ? (
                <p className="whitespace-pre-line text-sm">{plan.summary as string}</p>
              ) : (
                <p className="text-sm text-muted-foreground">No summary yet.</p>
              )}
              {plan.folder && (
                <div className="space-y-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Folder</h3>
                  {isFolderLink(plan.folder as string) ? (
                    <a
                      href={(plan.folder as string).trim()}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-primary underline break-all"
                    >
                      {plan.folder as string}
                    </a>
                  ) : (
                    <p className="text-sm break-all">{plan.folder as string}</p>
                  )}
                </div>
              )}
            </Section>
          )}

          {/* Milestones (editable — P6) */}
          <MilestonesSection
            planId={planId}
            milestones={milestoneItems}
            canEdit={canEdit}
            canDelete={editor}
            statuses={milestoneStatusOptions}
            priorities={priorityOptions}
            people={peopleOptions}
          />

          {/* Actions (editable, open first — P6) */}
          <ActionsSection
            planId={planId}
            actions={actionItems}
            canEdit={canEdit}
            canDelete={editor}
            chaserDays={chaserDays}
            today={today}
            types={actionTypeOptions}
            priorities={priorityOptions}
            people={peopleOptions}
            milestones={milestoneOptions}
            contacts={contactOptions}
          />

          {/* Update log */}
          <Section title="Update log">
            {canEdit && (
              <div className="mb-4">
                <LogUpdateForm planId={planId} sourceOptions={sourceOptions} today={today} />
              </div>
            )}
            {sortedUpdates.length === 0 ? (
              <p className="text-sm text-muted-foreground">No updates yet.</p>
            ) : (
              <ul className="space-y-3">
                {sortedUpdates.map((u) => {
                  const isHandover = u.kind === 'handover'
                  return (
                    <li
                      key={u.id as string}
                      className={cn(
                        'flex gap-3 border-l-2 pl-3 text-sm',
                        isHandover && 'rounded-r-md border-primary bg-primary/5 py-2',
                      )}
                    >
                      {/* Date + source on the left */}
                      <div className="w-28 shrink-0 space-y-0.5 text-xs text-muted-foreground">
                        <div>{formatDate(u.date as string)}</div>
                        {u.source && <div>{lookupLabel(lookups, 'source', u.source as string)}</div>}
                        {u.author_id && <div>by {names[u.author_id as string] || '—'}</div>}
                      </div>
                      <div className="min-w-0 flex-1 space-y-1">
                        {isHandover && <Badge variant="outline">Handover</Badge>}
                        <p className="whitespace-pre-line">{u.text as string}</p>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </Section>

          {/* Comments */}
          <CommentsSection planId={planId} comments={commentItems} canPost={canPostComment} />

          {/* History (FR-1.5) */}
          <PlanHistory items={historyItems} />
        </div>

        {/* Narrow column */}
        <div className="space-y-6">
          {/* People */}
          <Section title="People">
            <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Owner</dt>
              <dd>{names[plan.owner_id as string] || '—'}</dd>
              <dt className="text-muted-foreground">Lead</dt>
              <dd>{plan.lead_id ? (names[plan.lead_id as string] || '—') : '—'}</dd>
              {members && members.length > 0 && (
                <>
                  <dt className="text-muted-foreground">Members</dt>
                  <dd>{members.map((m) => names[m.user_id as string] || '—').join(', ')}</dd>
                </>
              )}
            </dl>
          </Section>

          {/* Project access — Managers / Group Owners only */}
          {editor && (
            <Section title="Project access">
              <p className="text-sm text-muted-foreground">
                Give a member Comment or Edit to let them work on this project.
              </p>
              <Link
                href={`/tracker/plans/${planId}/access`}
                className="text-sm text-primary underline"
              >
                Manage access
              </Link>
            </Section>
          )}

          {/* Dates */}
          <Section title="Dates">
            <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Start</dt>
              <dd>{formatDate(plan.start_on as string | null) || '—'}</dd>
              <dt className="text-muted-foreground">End</dt>
              <dd>{formatDate(plan.end_on as string | null) || '—'}</dd>
            </dl>
          </Section>

          {/* Sub-projects grouped by region */}
          {subPlans && subPlans.length > 0 && (
            <Section title="Sub-projects">
              {groupByRegion(subPlans as SubPlan[]).map((grp) => (
                <div key={grp.region} className="space-y-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {grp.region ? lookupLabel(lookups, 'region', grp.region) : 'No region'}
                  </h3>
                  <ul className="space-y-1">
                    {grp.plans.map((s) => (
                      <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                        <Link href={`/tracker/plans/${s.id}`} className="hover:underline">{s.name}</Link>
                        <StatusLabel statusKey={s.status} label={lookupLabel(lookups, 'status', s.status) || '—'} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </Section>
          )}

          {/* Contacts */}
          {(canEdit || contacts.length > 0) && (
            <ContactsSection
              planId={planId}
              contacts={contacts}
              canEdit={canEdit}
              linkable={linkableContacts}
            />
          )}
        </div>
      </div>
    </div>
  )
}

type SubPlan = { id: string; name: string; region: string | null; status: string | null }

function groupByRegion(subs: SubPlan[]): { region: string | null; plans: SubPlan[] }[] {
  const byRegion = new Map<string, SubPlan[]>()
  for (const s of subs) {
    const key = s.region ?? ''
    ;(byRegion.get(key) ?? byRegion.set(key, []).get(key)!).push(s)
  }
  return Array.from(byRegion.entries()).map(([region, plans]) => ({ region: region || null, plans }))
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  )
}
