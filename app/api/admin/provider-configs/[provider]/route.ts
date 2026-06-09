import { NextResponse }     from 'next/server'
import { createClient }     from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * DELETE /api/admin/provider-configs/{provider}
 *   → soft-deactivates (sets is_active=false) the provider config
 */

export async function DELETE(
  req: Request,
  { params }: { params: { provider: string } }
) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Check superadmin role
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .single()
  if (!membership || membership.role !== 'super_admin') {
    return NextResponse.json({ error: 'Superadmin access required' }, { status: 403 })
  }

  const provider = params.provider?.trim().toLowerCase()
  if (!provider) {
    return NextResponse.json({ error: 'Provider is required' }, { status: 400 })
  }

  const admin = createAdminClient()

  // Soft-deactivate (set is_active=false)
  const { error } = await admin
    .from('superadmin_provider_configs')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('provider', provider)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
