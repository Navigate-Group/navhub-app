'use client'

import { useState, useEffect } from 'react'
import { X, Loader2, Check, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn }     from '@/lib/utils'
import {
  FEATURE_KEYS,
  FEATURE_LABELS,
  ROLE_LABELS,
  STAFF_ADMIN_ONLY_FEATURES,
  roleDefaultAccess,
  type AppRole,
  type FeatureKey,
  type AccessLevel,
  type PermissionMatrix,
} from '@/lib/types'

interface PermissionsModalProps {
  /** Omit in invite mode — no existing user yet. */
  userId?:    string
  groupId:    string
  email:      string
  role:       AppRole
  companies:  { id: string; name: string }[]
  /** Caller's role on the group — gates the staff 'Admin only' override. */
  callerRole?: string
  /** When true, the modal collects permissions for a pending invite instead
   *  of saving them to an existing user. onSavePermissions receives the
   *  flattened permission list and the modal closes — no API call. */
  inviteMode?: boolean
  /** Allow switching the role via the tab selector (invite mode). When set,
   *  the parent is told about a role change so its own selector stays in sync. */
  onRoleChange?: (role: AppRole) => void
  /** Invite-mode save: receives the flattened permission rows. */
  onSavePermissions?: (
    role: AppRole,
    permissions: Array<{ feature: FeatureKey; company_id: string | null; access: AccessLevel }>,
  ) => void
  onSave:    () => void
  onClose:   () => void
}

const ACCESS_OPTIONS: { value: AccessLevel; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'view', label: 'View' },
  { value: 'edit', label: 'Edit' },
]

// Roles selectable via the top tab strip. Admin roles bypass the matrix, so
// only the matrix-driven roles appear here.
const ROLE_TABS: AppRole[] = ['group_admin', 'manager', 'staff', 'viewer']

const ROLE_BANNERS: Record<AppRole, string> = {
  super_admin: 'Super admins have full platform access.',
  group_owner: 'Group owners have full access to every feature in the group.',
  group_admin: 'Group admins have full access to every feature and can manage members.',
  manager:     'Managers default to Edit access across all features. Adjust any feature below.',
  staff:       'Staff can edit Reports, Documents and Agents. Financials and Marketing are Admin only and cannot be granted by a group admin.',
  viewer:      'Viewers have no access by default. Grant View or Edit per feature below.',
}

function accessColor(a: AccessLevel): string {
  if (a === 'edit') return 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 border-green-300 dark:border-green-700'
  if (a === 'view') return 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-700'
  return 'bg-muted text-muted-foreground border-border'
}

// Features shown in the grid (exclude settings — handled separately)
const GRID_FEATURES = FEATURE_KEYS.filter(f => f !== 'settings')

/** Build a matrix pre-filled with the given role's defaults. */
function defaultMatrixForRole(role: AppRole, companies: { id: string }[]): PermissionMatrix {
  const m = {} as PermissionMatrix
  FEATURE_KEYS.forEach(f => {
    const lvl = roleDefaultAccess(role, f)
    m[f] = { default: lvl }
    companies.forEach(c => { m[f][c.id] = lvl })
  })
  return m
}

export default function PermissionsModal({
  userId,
  groupId,
  email,
  role,
  companies,
  callerRole,
  inviteMode = false,
  onRoleChange,
  onSavePermissions,
  onSave,
  onClose,
}: PermissionsModalProps) {
  const [activeRole, setActiveRole] = useState<AppRole>(role)
  const [matrix, setMatrix]     = useState<PermissionMatrix>(
    () => (inviteMode ? defaultMatrixForRole(role, companies) : ({} as PermissionMatrix)),
  )
  const [loading, setLoading]   = useState(!inviteMode)
  const [saving, setSaving]     = useState(false)
  const [saved, setSaved]       = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  // Whether the current caller can raise staff 'Admin only' features. When
  // they can't, those rows are locked at 'none' and shown as 'Admin only'.
  const canOverrideStaff =
    callerRole === 'super_admin' || callerRole === 'group_owner'

  // Load existing permissions (edit mode only)
  useEffect(() => {
    if (inviteMode || !userId) return
    async function load() {
      try {
        const res  = await fetch(`/api/groups/${groupId}/members/${userId}/permissions`)
        const json = await res.json() as { data?: { matrix: PermissionMatrix } }
        if (json.data?.matrix) {
          setMatrix(json.data.matrix)
          const settingsPerms = json.data.matrix.settings ?? {}
          setShowSettings(Object.values(settingsPerms).some(a => a !== 'none'))
        }
      } catch { /* ignore */ }
      setLoading(false)
    }
    void load()
  }, [groupId, userId, inviteMode])

  /** True when this feature row is locked to 'none' for the active role. */
  function isLocked(feature: FeatureKey): boolean {
    if (activeRole !== 'staff') return false
    if (!STAFF_ADMIN_ONLY_FEATURES.includes(feature)) return false
    // Owner / super_admin may unlock the override; everyone else sees it locked.
    return !canOverrideStaff
  }

  function applyRoleDefaults(nextRole: AppRole) {
    setActiveRole(nextRole)
    setMatrix(defaultMatrixForRole(nextRole, companies))
    setShowSettings(false)
    onRoleChange?.(nextRole)
  }

  function setCell(feature: FeatureKey, companyKey: string, value: AccessLevel) {
    if (isLocked(feature)) return
    setMatrix(prev => ({
      ...prev,
      [feature]: { ...prev[feature], [companyKey]: value },
    }))
  }

  function setRow(feature: FeatureKey, value: AccessLevel) {
    if (isLocked(feature)) return
    const newFeature: Record<string, AccessLevel> = { default: value }
    companies.forEach(c => { newFeature[c.id] = value })
    setMatrix(prev => ({ ...prev, [feature]: newFeature }))
  }

  function buildPermissionRows() {
    const permissions: Array<{ feature: FeatureKey; company_id: string | null; access: AccessLevel }> = []
    for (const feature of FEATURE_KEYS) {
      // Force staff 'Admin only' features to 'none' when locked, regardless of
      // any stale matrix state.
      if (isLocked(feature)) {
        permissions.push({ feature, company_id: null, access: 'none' })
        continue
      }
      const perms = matrix[feature] ?? {}
      for (const [key, access] of Object.entries(perms)) {
        permissions.push({ feature, company_id: key === 'default' ? null : key, access })
      }
    }
    return permissions
  }

  async function handleSave() {
    const permissions = buildPermissionRows()

    // Invite mode — hand the matrix back to the caller, no API call.
    if (inviteMode) {
      onSavePermissions?.(activeRole, permissions)
      onClose()
      return
    }

    setSaving(true)
    setSaved(false)
    try {
      await fetch(`/api/groups/${groupId}/members/${userId}/permissions`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ permissions }),
      })
      setSaved(true)
      setTimeout(() => { onSave(); onClose() }, 500)
    } finally {
      setSaving(false)
    }
  }

  const visibleFeatures = showSettings ? [...GRID_FEATURES, 'settings' as FeatureKey] : GRID_FEATURES

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background rounded-xl shadow-2xl border w-[90vw] max-w-4xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <div>
            <h2 className="text-base font-semibold">{inviteMode ? 'Set Permissions' : 'Manage Access'}</h2>
            <p className="text-sm text-muted-foreground">{email} &middot; {ROLE_LABELS[activeRole]}</p>
          </div>
          <button onClick={onClose}><X className="h-5 w-5 text-muted-foreground" /></button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
            {/* Role tab selector */}
            <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-1 w-fit">
              {ROLE_TABS.map(r => (
                <button
                  key={r}
                  type="button"
                  onClick={() => applyRoleDefaults(r)}
                  className={cn(
                    'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                    activeRole === r
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {ROLE_LABELS[r]}
                </button>
              ))}
            </div>

            {/* Per-role descriptive banner */}
            <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              {ROLE_BANNERS[activeRole]}
            </div>

            {/* Admin roles bypass the matrix entirely */}
            {(activeRole === 'group_admin') ? (
              <div className="rounded-lg border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
                Group admins have full access to every feature. There is nothing to configure here.
              </div>
            ) : (
              <>
                {/* Settings grant toggle */}
                <div className="flex items-center gap-4 flex-wrap">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={showSettings}
                      onChange={e => {
                        setShowSettings(e.target.checked)
                        if (!e.target.checked) {
                          setMatrix(prev => ({ ...prev, settings: { default: 'none' } }))
                        }
                      }}
                      className="rounded border-input"
                    />
                    Grant settings access
                  </label>
                </div>

                {/* Permissions grid */}
                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/50">
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground min-w-[140px]">Feature</th>
                        <th className="text-center px-2 py-2 font-medium text-muted-foreground min-w-[120px]">
                          All companies
                        </th>
                        {companies.map(c => (
                          <th key={c.id} className="text-center px-2 py-2 font-medium text-muted-foreground min-w-[100px] truncate max-w-[120px]">
                            {c.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {visibleFeatures.map(feature => {
                        const featurePerms = matrix[feature] ?? {}
                        const locked = isLocked(feature)
                        return (
                          <tr key={feature} className={cn('hover:bg-muted/30', locked && 'bg-muted/40')}>
                            <td className={cn('px-3 py-2 font-medium', locked ? 'text-muted-foreground' : 'text-foreground')}>
                              {FEATURE_LABELS[feature]}
                            </td>
                            {/* Row default setter — or 'Admin only' badge when locked */}
                            <td className="px-2 py-2 text-center">
                              {locked ? (
                                <span className="inline-flex items-center gap-1 rounded border border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
                                  <Lock className="h-3 w-3" /> Admin only
                                </span>
                              ) : (
                                <select
                                  value={featurePerms['default'] ?? 'none'}
                                  onChange={e => setRow(feature, e.target.value as AccessLevel)}
                                  className={cn(
                                    'h-7 rounded border text-xs px-1 w-20',
                                    accessColor(featurePerms['default'] ?? 'none'),
                                  )}
                                >
                                  {ACCESS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                              )}
                            </td>
                            {/* Per-company cells */}
                            {companies.map(c => (
                              <td key={c.id} className="px-2 py-2 text-center">
                                {locked ? (
                                  <span className="text-xs text-muted-foreground">—</span>
                                ) : (
                                  <select
                                    value={featurePerms[c.id] ?? featurePerms['default'] ?? 'none'}
                                    onChange={e => setCell(feature, c.id, e.target.value as AccessLevel)}
                                    className={cn(
                                      'h-7 rounded border text-xs px-1 w-20',
                                      accessColor(featurePerms[c.id] ?? featurePerms['default'] ?? 'none'),
                                    )}
                                  >
                                    {ACCESS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                  </select>
                                )}
                              </td>
                            ))}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Legend */}
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-3 w-3 rounded bg-green-200 dark:bg-green-800 border border-green-400" />
                    Edit
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-3 w-3 rounded bg-blue-200 dark:bg-blue-800 border border-blue-400" />
                    View
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-3 w-3 rounded bg-muted border border-border" />
                    No access
                  </span>
                  <span className="flex items-center gap-1">
                    <Lock className="h-3 w-3" />
                    Admin only (owner / super admin grants)
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t shrink-0">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void handleSave()} disabled={saving || loading} className="gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
            {saved ? 'Saved' : inviteMode ? 'Apply Permissions' : 'Save Permissions'}
          </Button>
        </div>
      </div>
    </div>
  )
}
