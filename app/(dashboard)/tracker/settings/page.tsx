import { redirect } from 'next/navigation'
import { unstable_noStore as noStore } from 'next/cache'
import { getTrackerContext, isEditor, getTrackerHeaderData, ensureGroupSetup } from '@/lib/tracker/server'
import { buildLookups, activeOptions, type LookupRow } from '@/lib/tracker/view'
import TrackerHeader from '@/components/tracker/TrackerHeader'
import TrackerSettings, {
  type SettingsValues,
  type SettingsLookupRow,
  type ParentProjectRow,
} from '@/components/tracker/TrackerSettings'

export const dynamic = 'force-dynamic'

/**
 * Tracker Settings (P8). Managers and Group Owners edit the tracker's numeric
 * thresholds, calendar settings and time zone, and manage the seven lookup
 * lists. The database is the real guard (RLS, migration 082); this page gates
 * at the UI level too — non-editors are sent to Projects. Every read and write
 * runs as the signed-in user through the server client.
 */
export default async function TrackerSettingsPage() {
  noStore()
  const ctx = await getTrackerContext()
  if (!ctx) redirect('/home')
  const { supabase, groupId } = ctx

  if (!(await isEditor(supabase, groupId))) redirect('/tracker/plans')

  // Make sure the group's settings + starting lists exist (editor-only RPC).
  await ensureGroupSetup(ctx)

  const [header, { data: settingsRow }, { data: lookupRows }, { data: planRows }] = await Promise.all([
    getTrackerHeaderData(ctx),
    supabase
      .from('tracker_settings')
      .select('chaser_days, stale_days, contact_followup_days, review_day, week_start, time_zone')
      .eq('group_id', groupId)
      .maybeSingle(),
    // Both shown and hidden values, so the lists show everything a Manager can
    // edit or reveal.
    supabase
      .from('tracker_lookups')
      .select('id, list, key, label, colour, sort_order, active')
      .eq('group_id', groupId)
      .order('sort_order', { ascending: true }),
    // Every non-archived project the reader can see (RLS already filters), so we
    // can list the parents (projects that have sub-projects) with their counts.
    supabase
      .from('tracker_project_plans')
      .select('id, name, parent_id')
      .eq('group_id', groupId)
      .is('archived_at', null)
      .order('name', { ascending: true }),
  ])

  const settings: SettingsValues = {
    chaser_days: (settingsRow?.chaser_days as number | null) ?? 5,
    stale_days: (settingsRow?.stale_days as number | null) ?? 21,
    contact_followup_days: (settingsRow?.contact_followup_days as number | null) ?? 21,
    review_day: (settingsRow?.review_day as string | null) ?? 'friday',
    week_start: (settingsRow?.week_start as string | null) ?? 'monday',
    time_zone: (settingsRow?.time_zone as string | null) ?? 'Australia/Perth',
  }

  const lookups: SettingsLookupRow[] = (lookupRows ?? []).map((r) => ({
    id: r.id as string,
    list: r.list as string,
    key: r.key as string,
    label: r.label as string,
    sort_order: (r.sort_order as number) ?? 0,
    active: (r.active as boolean) ?? true,
  }))

  // The dropdowns in the Add parent project form use the group's shown
  // category and region lists, just like the New / Edit project form.
  const allLookups = buildLookups((lookupRows ?? []) as unknown as LookupRow[])
  const categories = activeOptions(allLookups, 'category')
  const regions = activeOptions(allLookups, 'region')

  // Count each project's sub-projects, then keep only the parents (those with
  // at least one sub-project), in name order.
  const plans = (planRows ?? []) as { id: string; name: string; parent_id: string | null }[]
  const subCounts = new Map<string, number>()
  for (const p of plans) {
    if (p.parent_id) subCounts.set(p.parent_id, (subCounts.get(p.parent_id) ?? 0) + 1)
  }
  const parentProjects: ParentProjectRow[] = plans
    .filter((p) => subCounts.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, subCount: subCounts.get(p.id) ?? 0 }))

  return (
    <div className="space-y-4">
      <TrackerHeader groupName={header.groupName} title="Settings" showSettings={header.showSettings} />
      <TrackerSettings
        settings={settings}
        lookups={lookups}
        parentProjects={parentProjects}
        categories={categories}
        regions={regions}
      />
    </div>
  )
}
