import { notFound, redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import Link from 'next/link'
import { getTrackerContext, isEditor, canAccess, getGroupPeople, nameMap } from '@/lib/tracker/server'
import {
  buildLookups,
  lookupLabel,
  formatDate,
  formatDateTime,
  isFolderLink,
  type LookupRow,
  type MilestoneProgressRow,
} from '@/lib/tracker/view'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import PlanStatusSelect from '@/components/tracker/PlanStatusSelect'
import LogUpdateForm from '@/components/tracker/LogUpdateForm'
import PlanActions from '@/components/tracker/PlanActions'

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

  const [editor, canEdit] = await Promise.all([
    isEditor(supabase, groupId),
    canAccess(supabase, planId, 'edit'),
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
    .select('id, title, status, due_on, sort_order')
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
    .select('id, title, type, who, assignee_id, due_on, status')
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

  // Contacts linked to the plan.
  const { data: contactLinks } = await supabase
    .from('tracker_contact_plans')
    .select('contact:tracker_contacts(id, name, org, role)')
    .eq('group_id', groupId)
    .eq('plan_id', planId)
  type ContactRow = { id: string; name: string; org: string | null; role: string | null }
  const contacts: ContactRow[] = ((contactLinks ?? []) as unknown as { contact: ContactRow | ContactRow[] | null }[])
    .map((c) => (Array.isArray(c.contact) ? c.contact[0] ?? null : c.contact))
    .filter((c): c is ContactRow => c != null)

  // Members (lead/member rows). The plan's own lead_id/owner_id are shown too.
  const { data: members } = await supabase
    .from('tracker_plan_members')
    .select('user_id, role')
    .eq('plan_id', planId)

  const sourceOptions = (lookups.source ?? []).map((s) => ({ key: s.key, label: s.label }))
  const statusOptions = (lookups.status ?? []).map((s) => ({ key: s.key, label: s.label }))

  const lastUpdatedBy = plan.updated_by ? names[plan.updated_by as string] : null

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link href="/tracker/plans" className="hover:underline">Projects</Link>
          <span>/</span>
          <span className="truncate">{plan.name as string}</span>
        </div>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold">{plan.name as string}</h1>
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              {plan.category && <span>{lookupLabel(lookups, 'category', plan.category as string)}</span>}
              {plan.client && <span>· {plan.client as string}</span>}
              {plan.phase && <span>· {plan.phase as string}</span>}
              {plan.region && <span>· {lookupLabel(lookups, 'region', plan.region as string)}</span>}
            </div>
          </div>

          <PlanActions
            planId={planId}
            archived={plan.archived_at !== null}
            canEdit={canEdit}
            isEditor={editor}
            isOwner={isOwner}
          />
        </div>

        {/* Status + facts */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Status:</span>
            {canEdit ? (
              <PlanStatusSelect
                planId={planId}
                current={(plan.status as string | null) ?? ''}
                options={statusOptions}
              />
            ) : (
              <span>{lookupLabel(lookups, 'status', plan.status as string) || '—'}</span>
            )}
          </div>
          <div>
            <span className="text-muted-foreground">Priority: </span>
            {plan.priority === 'high' ? 'High' : 'Normal'}
          </div>
          {(plan.start_on || plan.end_on) && (
            <div>
              <span className="text-muted-foreground">Dates: </span>
              {formatDate(plan.start_on as string | null) || '—'} → {formatDate(plan.end_on as string | null) || '—'}
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Progress:</span>
            <div className="w-28"><Progress value={(plan.progress_pct as number) ?? 0} /></div>
            <span>{(plan.progress_pct as number) ?? 0}%</span>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Last updated by {lastUpdatedBy || '—'} · {formatDateTime(plan.updated_at as string)}
        </p>
      </div>

      {/* Summary */}
      {plan.summary && (
        <Section title="Summary">
          <p className="whitespace-pre-line text-sm">{plan.summary as string}</p>
        </Section>
      )}

      {/* Folder */}
      {plan.folder && (
        <Section title="Folder">
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
        </Section>
      )}

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
                    <Badge variant="secondary">{lookupLabel(lookups, 'status', s.status) || '—'}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Section>
      )}

      {/* Milestones (read-only) */}
      {milestones && milestones.length > 0 && (
        <Section title="Milestones">
          <ul className="space-y-2">
            {milestones.map((m) => {
              const p = progressById.get(m.id as string)
              const slipped = p && p.days_slipped != null && (p.days_slipped as number) > 0 ? (p.days_slipped as number) : 0
              return (
                <li key={m.id as string} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="font-medium">{m.title as string}</span>
                  <Badge variant="secondary">{lookupLabel(lookups, 'milestone_status', m.status as string) || (m.status as string)}</Badge>
                  {m.due_on && <span className="text-muted-foreground">due {formatDate(m.due_on as string)}</span>}
                  {p && <span className="text-muted-foreground">{p.done_actions} of {p.total_actions} · {p.progress_pct}%</span>}
                  {slipped > 0 && <Badge variant="warning">{slipped} days slipped</Badge>}
                  {p?.overdue && <Badge variant="error">Overdue</Badge>}
                </li>
              )
            })}
          </ul>
        </Section>
      )}

      {/* Actions (read-only) */}
      {sortedActions.length > 0 && (
        <Section title="Actions">
          <ul className="space-y-2">
            {sortedActions.map((a) => (
              <li key={a.id as string} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <Badge variant={a.status === 'done' ? 'success' : a.status === 'waiting' ? 'warning' : 'secondary'}>
                  {a.status === 'done' ? 'Done' : a.status === 'waiting' ? 'Waiting' : 'Open'}
                </Badge>
                <span className="font-medium">{a.title as string}</span>
                {a.type && <span className="text-muted-foreground">{lookupLabel(lookups, 'action_type', a.type as string)}</span>}
                <span className="text-muted-foreground">
                  {a.assignee_id ? (names[a.assignee_id as string] || '—') : ((a.who as string | null) || '—')}
                </span>
                {a.due_on && <span className="text-muted-foreground">due {formatDate(a.due_on as string)}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Update log */}
      <Section title="Update log">
        {canEdit && (
          <div className="mb-4">
            <LogUpdateForm planId={planId} sourceOptions={sourceOptions} today={new Date().toISOString().slice(0, 10)} />
          </div>
        )}
        {sortedUpdates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No updates yet.</p>
        ) : (
          <ul className="space-y-3">
            {sortedUpdates.map((u) => (
              <li key={u.id as string} className="space-y-1 border-l-2 pl-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{formatDate(u.date as string)}</span>
                  {u.kind === 'handover' && <Badge variant="outline">Handover</Badge>}
                  {u.source && <span>· {lookupLabel(lookups, 'source', u.source as string)}</span>}
                  {u.author_id && <span>· by {names[u.author_id as string] || '—'}</span>}
                </div>
                <p className="whitespace-pre-line text-sm">{u.text as string}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Contacts */}
      {contacts.length > 0 && (
        <Section title="Contacts">
          <ul className="space-y-1 text-sm">
            {contacts.map((c) => (
              <li key={c.id}>
                <span className="font-medium">{c.name}</span>
                {c.org && <span className="text-muted-foreground"> · {c.org}</span>}
                {c.role && <span className="text-muted-foreground"> · {c.role}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

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
