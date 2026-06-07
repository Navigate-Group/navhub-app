import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/admin/sage/settings — Load current Sage connection settings
 */
export async function GET() {
  const supabase = createClient()

  // Verify super_admin
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: memberships } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('role', 'super_admin')

  if (!memberships || memberships.length === 0) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Load settings (there should only be one row)
  const { data: settings, error } = await supabase
    .from('sage_settings')
    .select('*')
    .single()

  if (error && error.code !== 'PGRST116') { // PGRST116 = no rows
    console.error('[sage-settings] Failed to load settings:', error)
    return NextResponse.json({
      error: 'Failed to load settings',
      details: error.message || error.hint || String(error)
    }, { status: 500 })
  }

  return NextResponse.json({ settings: settings ?? null })
}

/**
 * POST /api/admin/sage/settings — Save Sage connection settings
 */
export async function POST(request: Request) {
  const supabase = createClient()

  // Verify super_admin
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: memberships } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('role', 'super_admin')

  if (!memberships || memberships.length === 0) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json()
  const { builder_url, shared_secret, app_slug } = body

  // Validate required fields
  if (!builder_url || !shared_secret || !app_slug) {
    return NextResponse.json(
      { error: 'Missing required fields: builder_url, shared_secret, app_slug' },
      { status: 400 }
    )
  }

  // Check if settings already exist
  const { data: existing } = await supabase
    .from('sage_settings')
    .select('id')
    .single()

  let result
  if (existing) {
    // Update existing row
    const { data, error } = await supabase
      .from('sage_settings')
      .update({
        builder_url,
        shared_secret,
        app_slug,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select()
      .single()

    if (error) {
      console.error('[sage-settings] Failed to update settings:', error)
      return NextResponse.json({
        error: 'Failed to update settings',
        details: error.message || error.hint || String(error)
      }, { status: 500 })
    }
    result = data
  } else {
    // Insert new row
    const { data, error } = await supabase
      .from('sage_settings')
      .insert({
        builder_url,
        shared_secret,
        app_slug,
      })
      .select()
      .single()

    if (error) {
      console.error('[sage-settings] Failed to create settings:', error)
      return NextResponse.json({
        error: 'Failed to create settings',
        details: error.message || error.hint || String(error)
      }, { status: 500 })
    }
    result = data
  }

  return NextResponse.json({ settings: result })
}
