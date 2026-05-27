import { NextResponse }         from 'next/server'
import { cookies }              from 'next/headers'
import { createClient }         from '@/lib/supabase/server'
import { createAdminClient }    from '@/lib/supabase/admin'
import { checkAndPatchV5Template } from '@/scripts/seed-v5-template'

export const runtime = 'nodejs'

// ── POST /api/dev/seed-v5-template ───────────────────────────────────────────
// Dev-only endpoint: checks the V5 "Role & Task Matrix" template for the active
// group and reports on slot / token / scaffold completeness.
// Returns 404 in production.

export async function POST() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  // Admin check
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId)
    .single()

  if (!membership || !['super_admin', 'group_owner', 'group_admin'].includes(membership.role)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const admin  = createAdminClient()

  // Run the check (no scaffold provided — if scaffold_html is empty the check
  // will report it; user should run POST /api/report-templates/seed to fix it).
  const result = await checkAndPatchV5Template(admin, activeGroupId)

  return NextResponse.json({
    data: {
      ...result,
      instructions: result.templateFound
        ? (result.scaffoldPresent
            ? 'Template is healthy. Use the Run V5 Test button on the template detail page to launch an agent test run.'
            : 'scaffold_html is empty. Run POST /api/report-templates/seed (or DELETE + re-seed) to restore the V5 scaffold.')
        : 'Template not found. Run POST /api/report-templates/seed to create it for this group.',
    },
  })
}
