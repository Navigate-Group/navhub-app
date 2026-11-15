'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

// ============================================================
// signIn — email + password auth
// ============================================================

export async function signIn(formData: FormData) {
  const email    = formData.get('email') as string
  const password = formData.get('password') as string

  if (!email || !password) {
    return { error: 'Email and password are required.' }
  }

  const supabase = createClient()

  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (authError || !authData.session) {
    return { error: authError?.message ?? 'Invalid email or password.' }
  }

  // Find the user's default group
  const { data: userGroups } = await supabase
    .from('user_groups')
    .select('group_id, is_default')
    .eq('user_id', authData.session.user.id)
    .order('is_default', { ascending: false })

  const defaultGroup =
    userGroups?.find((ug) => ug.is_default) ?? userGroups?.[0]

  if (defaultGroup) {
    const cookieStore = cookies()
    cookieStore.set('active_group_id', defaultGroup.group_id, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path:     '/',
      maxAge:   60 * 60 * 24 * 30, // 30 days
    })
  }

  redirect('/home')
}

// ============================================================
// signOut — clear session and active_group_id cookie
// ============================================================

export async function signOut() {
  const supabase = createClient()
  await supabase.auth.signOut()

  const cookieStore = cookies()
  cookieStore.delete('active_group_id')

  redirect('/login')
}

// ============================================================
// switchGroup — update active group cookie
// ============================================================

export async function switchGroup(groupId: string): Promise<{ primaryColor: string; palette_id: string } | { error: string }> {
  const supabase = createClient()

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return { error: 'Unauthorised' }

  // Verify user belongs to this group
  const { data: membership } = await supabase
    .from('user_groups')
    .select('group_id')
    .eq('user_id', session.user.id)
    .eq('group_id', groupId)
    .single()

  if (!membership) return { error: 'Access denied to this group.' }

  // Get group colour + palette
  const { data: group } = await supabase
    .from('groups')
    .select('primary_color, palette_id')
    .eq('id', groupId)
    .single()

  const cookieStore = cookies()
  cookieStore.set('active_group_id', groupId, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path:     '/',
    maxAge:   60 * 60 * 24 * 30,
  })

  return {
    primaryColor: group?.primary_color ?? '#0ea5e9',
    palette_id:   group?.palette_id   ?? 'ocean',
  }
}
