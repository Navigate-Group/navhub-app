/**
 * Permission helpers — server-side only.
 * Reads user_permissions table and returns a PermissionMatrix.
 */

import { createAdminClient } from './supabase/admin'
import type { AppRole, FeatureKey, AccessLevel, PermissionMatrix } from './types'
import { FEATURE_KEYS, STAFF_ADMIN_ONLY_FEATURES } from './types'

// Roles that bypass the user_permissions matrix entirely — they always get
// full edit on every feature. Group owners are admins-plus, so they're in
// here too. Adding 'group_owner' (migration 062) also fixes the issue where
// admins with no rows in user_permissions saw greyed-out buttons.
export const ADMIN_ROLES: AppRole[] = ['super_admin', 'group_owner', 'group_admin']

// Role hierarchy for "can X manage Y" decisions. Higher number = more power.
// super_admin is platform-level (cross-tenant); the other roles are scoped
// to a single group.
export const ROLE_RANK: Record<AppRole, number> = {
  super_admin: 100,
  group_owner: 80,
  group_admin: 60,
  manager:     40,
  // 'staff' (migration 068) sits between manager (40) and viewer (20). Like
  // manager/viewer it goes through the user_permissions matrix — it is NOT
  // an ADMIN_ROLE.
  staff:       30,
  viewer:      20,
}

/** True if the role is super_admin, group_owner or group_admin. */
export function isAdminRole(role: string | null | undefined): boolean {
  return !!role && ADMIN_ROLES.includes(role as AppRole)
}

/** True if `current` can manage `target` in the same group. */
export function canManageRole(current: string, target: string): boolean {
  // Nobody touches super_admins from in-group UI.
  if (target === 'super_admin') return false
  // Only super_admins can mint or modify group_owners.
  if (target === 'group_owner') return current === 'super_admin'
  // group_admins can only be modified by super_admin or group_owner.
  if (target === 'group_admin') return current === 'super_admin' || current === 'group_owner'
  // Otherwise compare ranks.
  const cur = ROLE_RANK[current as AppRole] ?? 0
  const tgt = ROLE_RANK[target as AppRole] ?? 0
  return cur > tgt
}

/** True if `current` can assign `newRole` to anyone. */
export function canAssignRole(current: string, newRole: string): boolean {
  if (newRole === 'super_admin') return current === 'super_admin'
  if (newRole === 'group_owner') return current === 'super_admin'
  if (newRole === 'group_admin') return current === 'super_admin' || current === 'group_owner'
  return isAdminRole(current)
}

// Roles that may raise a staff member's 'Admin only' features (financials,
// marketing) above 'none'. Group admins cannot — only owners / super admins.
const STAFF_OVERRIDE_ROLES: AppRole[] = ['super_admin', 'group_owner']

/**
 * True if the caller is allowed to set `access` on `feature` for a member of
 * the given `targetRole`. The only restriction: when the target is 'staff',
 * the 'Admin only' features (financials, marketing) may not be raised above
 * 'none' unless the caller is a group_owner or super_admin.
 *
 * Returns false → the API should reject the write with 403.
 */
export function canSetPermission(
  callerRole: string,
  targetRole: string,
  feature:    FeatureKey,
  access:     AccessLevel,
): boolean {
  if (
    targetRole === 'staff' &&
    STAFF_ADMIN_ONLY_FEATURES.includes(feature) &&
    access !== 'none'
  ) {
    return STAFF_OVERRIDE_ROLES.includes(callerRole as AppRole)
  }
  return true
}

/** Single-call gate used by feature components — covers the admin-bypass case. */
export function hasAccess(
  role:     string | null | undefined,
  access:   AccessLevel | null | undefined,
  required: 'view' | 'edit',
): boolean {
  if (isAdminRole(role)) return true
  if (!access) return false
  if (required === 'view') return access === 'view' || access === 'edit'
  return access === 'edit'
}

/** Build empty matrix with 'none' defaults */
function emptyMatrix(): PermissionMatrix {
  const m = {} as PermissionMatrix
  FEATURE_KEYS.forEach(f => { m[f] = { default: 'none' } })
  return m
}

/** Build full-edit matrix for admins */
function fullEditMatrix(): PermissionMatrix {
  const m = {} as PermissionMatrix
  FEATURE_KEYS.forEach(f => { m[f] = { default: 'edit' } })
  return m
}

/** Get full permission matrix for a user in a group */
export async function getUserPermissions(
  userId: string,
  groupId: string,
  userRole: AppRole,
): Promise<PermissionMatrix> {
  if (ADMIN_ROLES.includes(userRole)) {
    return fullEditMatrix()
  }

  const admin = createAdminClient()
  const { data } = await admin
    .from('user_permissions')
    .select('feature, company_id, access')
    .eq('user_id', userId)
    .eq('group_id', groupId)

  const matrix = emptyMatrix()

  for (const row of data ?? []) {
    const feature = row.feature as FeatureKey
    const key = row.company_id ?? 'default'
    if (!matrix[feature]) matrix[feature] = {}
    matrix[feature][key] = row.access as AccessLevel
  }

  return matrix
}

/** Get access level for a specific feature + optional company */
export function getAccess(
  matrix: PermissionMatrix,
  feature: FeatureKey,
  companyId?: string,
): AccessLevel {
  const featurePerms = matrix[feature] ?? {}
  if (companyId && featurePerms[companyId] !== undefined) {
    return featurePerms[companyId]
  }
  return featurePerms['default'] ?? 'none'
}

export function canView(matrix: PermissionMatrix, feature: FeatureKey, companyId?: string): boolean {
  const a = getAccess(matrix, feature, companyId)
  return a === 'view' || a === 'edit'
}

export function canEdit(matrix: PermissionMatrix, feature: FeatureKey, companyId?: string): boolean {
  return getAccess(matrix, feature, companyId) === 'edit'
}

export function canAccessSettings(role: AppRole): boolean {
  return isAdminRole(role)
}

/** Which features can the user see at all (has view or edit on at least one company or default) */
export function getVisibleFeatures(matrix: PermissionMatrix): FeatureKey[] {
  return (Object.keys(matrix) as FeatureKey[]).filter(f =>
    Object.values(matrix[f]).some(a => a === 'view' || a === 'edit'),
  )
}
