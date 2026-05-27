import { NextResponse } from 'next/server'
import { cookies }       from 'next/headers'
import { createClient }  from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { ToolParameter } from '@/lib/types'

// ─── GET — list custom tools for active group ──────────────────────────────

export async function GET() {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('custom_tools')
    .select('*')
    .eq('group_id', activeGroupId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data: data ?? [] })
}

// ─── POST — create a custom tool ──────────────────────────────────────────

function validSnakeCase(s: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(s)
}

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
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

  let body: Record<string, unknown>
  try { body = await request.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const name        = typeof body.name        === 'string' ? body.name.trim()        : ''
  const label       = typeof body.label       === 'string' ? body.label.trim()       : ''
  const description = typeof body.description === 'string' ? body.description.trim() : ''
  const webhook_url = typeof body.webhook_url === 'string' ? body.webhook_url.trim() : ''
  const http_method = typeof body.http_method === 'string' ? body.http_method        : 'POST'
  const headers     = (body.headers    ?? {}) as Record<string, string>
  const parameters  = (body.parameters ?? []) as ToolParameter[]

  if (!name  || !validSnakeCase(name)) return NextResponse.json({ error: 'Name must be snake_case (lowercase, digits, underscores)' }, { status: 422 })
  if (!label)                           return NextResponse.json({ error: 'Label is required' }, { status: 422 })
  if (!description)                     return NextResponse.json({ error: 'Description is required' }, { status: 422 })
  if (!webhook_url)                     return NextResponse.json({ error: 'Webhook URL is required' }, { status: 422 })
  if (!['GET','POST','PUT','PATCH'].includes(http_method)) {
    return NextResponse.json({ error: 'Invalid HTTP method' }, { status: 422 })
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('custom_tools')
    .insert({
      group_id:    activeGroupId,
      name, label, description, webhook_url, http_method,
      headers, parameters,
      is_active:   true,
      created_by:  session.user.id,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'A tool with that name already exists in this group.' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ data }, { status: 201 })
}
