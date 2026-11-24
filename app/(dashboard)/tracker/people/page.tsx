import { redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import { getTrackerContext, getTrackerHeaderData } from '@/lib/tracker/server'
import TrackerHeader from '@/components/tracker/TrackerHeader'
import PeopleTable, { type PersonRow, type PeopleProject } from '@/components/tracker/PeopleTable'

export const dynamic = 'force-dynamic'

/**
 * People (FR — external contacts).
 * ──────────────────────────────────────────────────────────────────────────
 * The group's external points of contact (partners, suppliers, growers, …),
 * their linked projects, and when they were last spoken to. Contacts not
 * spoken to for the follow-up window (contact_followup_days, 21 by default) or
 * never, are highlighted so the team can keep relationships warm.
 *
 * Reads run as the signed-in user through the Supabase server client, so RLS
 * (082) decides what is visible and who may act. Members see every non-archived
 * contact; the per-row "can I edit this?" and the page-level "can I add?" come
 * from the same database functions the write policies use
 * (tracker_contact_can_edit, tracker_can_add_contact), so the buttons appear
 * only where the database will actually allow the action.
 */
export default async function PeoplePage() {
  noStore()
  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')
  const { supabase, groupId, userId } = ctx

  const [
    header,
    { data: settingsRow },
    { data: todayVal },
    { data: contactRows },
    { data: linkRows },
    { data: planRows },
    { data: canAddVal },
  ] = await Promise.all([
    getTrackerHeaderData(ctx),
    supabase
      .from('tracker_settings')
      .select('contact_followup_days')
      .eq('group_id', groupId)
      .maybeSingle(),
    supabase.rpc('tracker_today', { p_group_id: groupId }),
    // Non-archived contacts, sorted by organisation then name (nulls last); RLS
    // scopes to the group and to what the member is allowed to see.
    supabase
      .from('tracker_contacts')
      .select('id, name, org, role, phone, email, notes, last_contact')
      .eq('group_id', groupId)
      .is('archived_at', null)
      .order('org', { ascending: true, nullsFirst: false })
      .order('name', { ascending: true }),
    supabase.from('tracker_contact_plans').select('contact_id, plan_id').eq('group_id', groupId),
    supabase
      .from('tracker_project_plans')
      .select('id, name')
      .eq('group_id', groupId)
      .is('archived_at', null),
    supabase.rpc('tracker_can_add_contact', { p_group_id: groupId }),
  ])

  const followUpDays =
    typeof settingsRow?.contact_followup_days === 'number'
      ? (settingsRow.contact_followup_days as number)
      : 21
  const today = typeof todayVal === 'string' ? todayVal : new Date().toISOString().slice(0, 10)
  const canAdd = canAddVal === true

  const planNameById = new Map<string, string>()
  for (const p of planRows ?? []) planNameById.set(p.id as string, (p.name as string) ?? '')

  // Projects per contact (only plans the reader can see / that still exist).
  const projectsByContact = new Map<string, PeopleProject[]>()
  for (const l of linkRows ?? []) {
    const name = planNameById.get(l.plan_id as string)
    if (!name) continue
    const list = projectsByContact.get(l.contact_id as string) ?? []
    list.push({ id: l.plan_id as string, name })
    projectsByContact.set(l.contact_id as string, list)
  }
  for (const list of Array.from(projectsByContact.values())) {
    list.sort((a, b) => a.name.localeCompare(b.name))
  }

  const contacts = (contactRows ?? []) as {
    id: string
    name: string
    org: string | null
    role: string | null
    phone: string | null
    email: string | null
    notes: string | null
    last_contact: string | null
  }[]

  // Per-contact edit permission from the same database function the UPDATE
  // policy uses, so the buttons only show where the database will allow it.
  // Editors (Managers / Group Owners) can edit everyone, so skip the per-row
  // calls in that common case — header.showSettings is exactly isEditor.
  let canEditById = new Map<string, boolean>()
  if (header.showSettings) {
    for (const c of contacts) canEditById.set(c.id, true)
  } else {
    const results = await Promise.all(
      contacts.map((c) =>
        supabase
          .rpc('tracker_contact_can_edit', { p_contact_id: c.id, p_group_id: groupId })
          .then(({ data }) => [c.id, data === true] as const),
      ),
    )
    canEditById = new Map(results)
  }

  const people: PersonRow[] = contacts.map((c) => ({
    id: c.id,
    name: c.name,
    org: c.org,
    role: c.role,
    phone: c.phone,
    email: c.email,
    notes: c.notes,
    last_contact: c.last_contact,
    projects: projectsByContact.get(c.id) ?? [],
    canEdit: canEditById.get(c.id) ?? false,
  }))

  const groupLine = header.groupName
    ? `${header.groupName} · external points of contact, linked to projects`
    : 'External points of contact, linked to projects'

  return (
    <>
      <TrackerHeader groupName={groupLine} title="People" showSettings={header.showSettings} />
      <PeopleTable
        people={people}
        canAdd={canAdd}
        followUpDays={followUpDays}
        today={today}
        currentUserId={userId}
      />
    </>
  )
}
