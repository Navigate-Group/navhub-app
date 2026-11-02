/**
 * Markets access & role helpers — server-side only (MKT-1).
 *
 * Markets roles live in `market_user_roles` and are INDEPENDENT of the
 * per-group `user_groups` roles. A platform super admin (user_groups.role =
 * 'super_admin') is ALWAYS treated as a Markets super admin and bypasses the
 * table entirely.
 *
 * ⚠️  Import only in server-side code (Route Handlers / Server Components /
 *     middleware). These helpers read the DB with the caller's own client so
 *     they honour RLS unless an admin client is passed.
 */

import { createAdminClient } from './supabase/admin'
import type { SupabaseClient } from '@supabase/supabase-js'

/** The two grantable Markets roles. */
export type MarketsRole = 'markets_viewer' | 'markets_manager'

/**
 * The effective Markets access level for a user, after collapsing the
 * (independent) super-admin override and the highest active grant.
 *   - 'super'   → platform super admin: full access to everything Markets.
 *   - 'manager' → markets_manager grant: explorer + curation surfaces.
 *   - 'viewer'  → markets_viewer grant: explorer only.
 *   - null      → no Markets access.
 */
export type MarketsAccess = 'super' | 'manager' | 'viewer' | null

/** True if the user holds a platform super_admin membership. */
export async function isPlatformSuperAdmin(
  client: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data } = await client
    .from('user_groups')
    .select('role')
    .eq('user_id', userId)
    .eq('role', 'super_admin')
    .limit(1)
  return (data?.length ?? 0) > 0
}

/**
 * Resolve a user's effective Markets access. Pass the request-scoped Supabase
 * client (middleware / server component) — RLS lets a user read their own
 * market_user_roles rows, and super admins read all rows.
 */
export async function getMarketsAccess(
  client: SupabaseClient,
  userId: string,
): Promise<MarketsAccess> {
  // Super admins are always Markets super admins — short-circuit.
  if (await isPlatformSuperAdmin(client, userId)) return 'super'

  const { data } = await client
    .from('market_user_roles')
    .select('role')
    .eq('user_id', userId)
    .is('revoked_at', null)

  const roles = new Set((data ?? []).map(r => (r as { role: string }).role))
  if (roles.has('markets_manager')) return 'manager'
  if (roles.has('markets_viewer'))  return 'viewer'
  return null
}

/** True if access allows reaching the Markets explorer (/markets). */
export function canViewMarkets(access: MarketsAccess): boolean {
  return access === 'super' || access === 'manager' || access === 'viewer'
}

/** True if access allows reaching Markets curation surfaces (/markets/manage). */
export function canManageMarkets(access: MarketsAccess): boolean {
  return access === 'super' || access === 'manager'
}

/**
 * Admin-client variant used by server routes that must read ALL users' roles
 * (bypassing RLS). The list excludes revoked grants.
 */
export async function listActiveMarketsRoles(): Promise<
  Array<{ user_id: string; role: MarketsRole; granted_at: string }>
> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('market_user_roles')
    .select('user_id, role, granted_at')
    .is('revoked_at', null)
  return (data ?? []) as Array<{ user_id: string; role: MarketsRole; granted_at: string }>
}
