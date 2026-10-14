'use client'

import { useState, useEffect } from 'react'
import { X, Plus, Star, Trash2, ShieldCheck } from 'lucide-react'

interface Group {
  id:   string
  name: string
}

interface GroupMembership {
  group_id:   string
  group_name: string
  role:       string
  is_default: boolean
}

interface UserFormModalProps {
  /** If set, editing an existing user */
  user?: {
    id:       string
    email:    string
    group_id: string
    role:     string
    /** All group memberships for this user */
    memberships?: GroupMembership[]
  }
  onClose: () => void
  onSaved: () => void
  /**
   * Whether the CURRENT viewer is a superadmin. Only superadmins may promote
   * other users to superadmin. Defaults to true because this modal is only
   * reachable from the superadmin-gated /admin area, but kept explicit so the
   * promotion control can never render for a non-superadmin.
   */
  isSuperAdmin?: boolean
}

const ROLES = [
  { value: 'group_admin', label: 'Group Admin',  description: 'Full access to all group features' },
  { value: 'manager',     label: 'Manager',       description: 'Access controlled by permissions matrix' },
  { value: 'staff',       label: 'Staff',         description: 'Edit reports, documents & agents; financials & marketing are admin only' },
  { value: 'viewer',      label: 'Viewer',        description: 'Access controlled by permissions matrix' },
]

export default function UserFormModal({ user, onClose, onSaved, isSuperAdmin = true }: UserFormModalProps) {
  const isEdit = !!user

  // New user fields
  const [email,    setEmail]    = useState(user?.email ?? '')
  const [groupId,  setGroupId]  = useState(user?.group_id ?? '')
  const [role,     setRole]     = useState(user?.role ?? 'viewer')

  // All groups list (for selectors)
  const [groups,   setGroups]   = useState<Group[]>([])
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  // Set once an invite email has been sent for a new user.
  const [invitedEmail, setInvitedEmail] = useState<string | null>(null)

  // Multi-group management (edit mode)
  const [memberships, setMemberships] = useState<GroupMembership[]>(
    user?.memberships ?? (user?.group_id ? [{ group_id: user.group_id, group_name: '', role: user.role, is_default: true }] : [])
  )
  const [showAddGroup, setShowAddGroup] = useState(false)
  const [addGroupId,   setAddGroupId]   = useState('')
  const [addRole,      setAddRole]      = useState('viewer')
  const [addingGroup,  setAddingGroup]  = useState(false)
  const [updatingMembership, setUpdatingMembership] = useState<string | null>(null)

  // Superadmin promotion (edit mode) — confirm dialog + success message state
  const [showPromoteConfirm, setShowPromoteConfirm] = useState(false)
  const [promoting,          setPromoting]          = useState(false)
  const [promoteError,       setPromoteError]       = useState<string | null>(null)
  const [promoted,           setPromoted]           = useState(false)

  useEffect(() => {
    fetch('/api/admin/groups')
      .then(r => r.json())
      .then(json => {
        const list = (json.data ?? []) as { id: string; name: string }[]
        setGroups(list)
        if (!groupId && list.length > 0) setGroupId(list[0].id)
        if (!addGroupId && list.length > 0) setAddGroupId(list[0].id)
        // Enrich membership group names
        if (user?.memberships) {
          setMemberships(prev => prev.map(m => ({
            ...m,
            group_name: list.find(g => g.id === m.group_id)?.name ?? m.group_name,
          })))
        }
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load fresh memberships from server for edit mode
  async function loadMemberships() {
    if (!user) return
    try {
      const res = await fetch(`/api/admin/users/${user.id}/groups`)
      const json = await res.json() as { data?: GroupMembership[] }
      if (json.data) {
        setMemberships(json.data.map(m => ({
          ...m,
          group_name: groups.find(g => g.id === m.group_id)?.name ?? m.group_name,
        })))
      }
    } catch { /* ignore */ }
  }

  // Load memberships on mount for edit mode
  useEffect(() => {
    if (isEdit && user?.id) void loadMemberships()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, user?.id])

  async function handleSave() {
    if (!isEdit && !email.trim()) { setError('Email is required.'); return }
    if (!isEdit && !groupId) { setError('Please select a group.'); return }

    setSaving(true)
    setError(null)

    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), group_id: groupId, role }),
      })
      const json = await res.json() as { error?: string }
      if (!res.ok) { setError(json.error ?? 'Failed to save.'); return }
      // Show a confirmation that the invite email was sent rather than
      // silently closing — the new user sets their own password via the link.
      setInvitedEmail(email.trim())
    } finally {
      setSaving(false)
    }
  }

  async function handleRoleChange(groupId: string, newRole: string) {
    if (!user) return
    setUpdatingMembership(groupId)
    try {
      const res = await fetch(`/api/admin/users/${user.id}/groups/${groupId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      })
      if (res.ok) {
        setMemberships(prev => prev.map(m => m.group_id === groupId ? { ...m, role: newRole } : m))
        void loadMemberships()
      }
    } catch {
      // ignore
    } finally {
      setUpdatingMembership(null)
    }
  }

  async function handleSetDefault(targetGroupId: string) {
    if (!user) return
    setUpdatingMembership(targetGroupId)
    try {
      const res = await fetch(`/api/admin/users/${user.id}/groups/${targetGroupId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_default: true }),
      })
      if (res.ok) {
        setMemberships(prev => prev.map(m => ({ ...m, is_default: m.group_id === targetGroupId })))
        void loadMemberships()
      }
    } catch {
      // ignore
    } finally {
      setUpdatingMembership(null)
    }
  }

  async function handleRemoveMembership(targetGroupId: string) {
    if (!user) return
    if (!confirm('Remove this user from the group?')) return
    setUpdatingMembership(targetGroupId)
    try {
      const res = await fetch(`/api/admin/users/${user.id}/groups/${targetGroupId}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        setMemberships(prev => prev.filter(m => m.group_id !== targetGroupId))
        void loadMemberships()
      }
    } catch {
      // ignore
    } finally {
      setUpdatingMembership(null)
    }
  }

  async function handleAddGroup() {
    if (!user || !addGroupId) return
    setAddingGroup(true)
    try {
      const res = await fetch(`/api/admin/users/${user.id}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_id: addGroupId, role: addRole }),
      })
      if (res.ok) {
        const newMembership: GroupMembership = {
          group_id:   addGroupId,
          group_name: groups.find(g => g.id === addGroupId)?.name ?? '',
          role:       addRole,
          is_default: false,
        }
        setMemberships(prev => {
          // Avoid duplicates — update role if already present
          const existing = prev.find(m => m.group_id === addGroupId)
          if (existing) return prev.map(m => m.group_id === addGroupId ? { ...m, role: addRole } : m)
          return [...prev, newMembership]
        })
        setShowAddGroup(false)
        setAddGroupId(availableGroups.filter(g => g.id !== addGroupId)[0]?.id ?? '')
        setAddRole('viewer')
        void loadMemberships()
      }
    } catch {
      // ignore
    } finally {
      setAddingGroup(false)
    }
  }

  async function handlePromoteToSuperAdmin() {
    if (!user) return
    setPromoting(true)
    setPromoteError(null)
    try {
      // Elevate the user's default membership (fall back to the first one).
      const targetGroupId =
        memberships.find(m => m.is_default)?.group_id ?? memberships[0]?.group_id
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'super_admin', group_id: targetGroupId }),
      })
      const json = await res.json() as { error?: string }
      if (!res.ok) { setPromoteError(json.error ?? 'Failed to promote user.'); return }
      setShowPromoteConfirm(false)
      setPromoted(true)
      // Reflect the new role locally so the toggle hides immediately.
      setMemberships(prev => prev.map(m =>
        m.group_id === targetGroupId ? { ...m, role: 'super_admin' } : m,
      ))
      void loadMemberships()
    } catch {
      setPromoteError('Failed to promote user.')
    } finally {
      setPromoting(false)
    }
  }

  // The target user is already a superadmin if ANY membership carries the role.
  const isAlreadySuperAdmin = memberships.some(m => m.role === 'super_admin')
  const userDisplayName = user?.email ?? 'this user'

  // Groups not yet assigned to this user
  const availableGroups = groups.filter(g => !memberships.some(m => m.group_id === g.id))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Panel */}
      <div className="relative z-10 w-full max-w-lg bg-zinc-900 border border-zinc-700 rounded-2xl shadow-xl p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-white">{isEdit ? 'Edit User' : 'New User'}</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* New user — invite sent confirmation */}
        {!isEdit && invitedEmail && (
          <div className="space-y-5">
            <div className="rounded-lg border border-emerald-800 bg-emerald-900/20 px-4 py-4">
              <p className="text-sm font-medium text-emerald-300">Invite sent</p>
              <p className="mt-1 text-sm text-emerald-200/80">
                An invitation email has been sent to{' '}
                <span className="font-mono text-emerald-100">{invitedEmail}</span>. They&apos;ll
                click the link in the email to accept and set their own password — no password
                is created or shared here.
              </p>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => onSaved()}
                className="px-4 py-2 text-sm font-medium bg-amber-500 hover:bg-amber-400 text-black rounded-lg transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        )}

        {/* New user form */}
        {!isEdit && !invitedEmail && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Email *</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="user@company.com"
                className="w-full h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Group *</label>
              <select
                value={groupId}
                onChange={e => setGroupId(e.target.value)}
                className="w-full h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
              >
                {groups.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Role</label>
              <select
                value={role}
                onChange={e => setRole(e.target.value)}
                className="w-full h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
              >
                {ROLES.map(r => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>

            <p className="text-xs text-zinc-500 bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2">
              An invitation email will be sent to this address. The user sets their own password
              via the link — no password is created or shared here.
            </p>

            {error && (
              <p className="text-sm text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleSave()}
                disabled={saving}
                className="px-4 py-2 text-sm font-medium bg-amber-500 hover:bg-amber-400 text-black rounded-lg transition-colors disabled:opacity-60"
              >
                {saving ? 'Sending…' : 'Send Invite'}
              </button>
            </div>
          </div>
        )}

        {/* Edit user — multi-group management */}
        {isEdit && (
          <div className="space-y-5">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Email</label>
              <p className="text-sm text-white font-mono">{user!.email}</p>
            </div>

            {/* Group memberships table */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-zinc-400">Group Memberships</label>
                {availableGroups.length > 0 && (
                  <button
                    onClick={() => setShowAddGroup(v => !v)}
                    className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 transition-colors"
                  >
                    <Plus className="h-3 w-3" />
                    Add to Group
                  </button>
                )}
              </div>

              {memberships.length === 0 && (
                <p className="text-xs text-zinc-600 italic">No group memberships.</p>
              )}

              <div className="space-y-1">
                {memberships.map(m => (
                  <div
                    key={m.group_id}
                    className="flex items-center gap-2 py-1.5 px-2 rounded-lg bg-zinc-800 border border-zinc-700"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">{m.group_name || m.group_id}</p>
                      {m.is_default && (
                        <span className="text-[10px] text-amber-400">Default group</span>
                      )}
                    </div>

                    {/* Role selector */}
                    <select
                      value={m.role}
                      onChange={e => void handleRoleChange(m.group_id, e.target.value)}
                      disabled={updatingMembership === m.group_id}
                      className="h-7 text-xs rounded border border-zinc-600 bg-zinc-700 text-white px-1.5 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50"
                    >
                      {ROLES.map(r => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                    </select>

                    {/* Set Default button */}
                    {!m.is_default && (
                      <button
                        onClick={() => void handleSetDefault(m.group_id)}
                        disabled={updatingMembership === m.group_id}
                        title="Set as default group"
                        className="p-1 text-zinc-500 hover:text-amber-400 transition-colors disabled:opacity-50"
                      >
                        <Star className="h-3.5 w-3.5" />
                      </button>
                    )}

                    {/* Remove button */}
                    <button
                      onClick={() => void handleRemoveMembership(m.group_id)}
                      disabled={updatingMembership === m.group_id}
                      title="Remove from group"
                      className="p-1 text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>

              {/* Add to group inline form */}
              {showAddGroup && availableGroups.length > 0 && (
                <div className="mt-2 p-3 rounded-lg border border-zinc-700 bg-zinc-800/50 space-y-2">
                  <p className="text-xs text-zinc-400 font-medium">Add to Group</p>
                  <div className="flex gap-2">
                    <select
                      value={addGroupId}
                      onChange={e => setAddGroupId(e.target.value)}
                      className="flex-1 h-8 text-xs rounded border border-zinc-600 bg-zinc-700 text-white px-2 focus:outline-none focus:ring-1 focus:ring-amber-500"
                    >
                      {availableGroups.map(g => (
                        <option key={g.id} value={g.id}>{g.name}</option>
                      ))}
                    </select>
                    <select
                      value={addRole}
                      onChange={e => setAddRole(e.target.value)}
                      className="h-8 text-xs rounded border border-zinc-600 bg-zinc-700 text-white px-2 focus:outline-none focus:ring-1 focus:ring-amber-500"
                    >
                      {ROLES.map(r => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => void handleAddGroup()}
                      disabled={addingGroup}
                      className="h-8 px-3 text-xs font-medium bg-amber-500 hover:bg-amber-400 text-black rounded transition-colors disabled:opacity-60"
                    >
                      {addingGroup ? '…' : 'Add'}
                    </button>
                    <button
                      onClick={() => setShowAddGroup(false)}
                      className="h-8 px-2 text-xs text-zinc-500 hover:text-white transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* ── Superadmin promotion ─────────────────────────────────────────
                Visible only to superadmins, and only when the edited user is not
                already a superadmin. Shows a confirmation dialog, then a success
                message with copy-paste onboarding instructions. */}
            {isSuperAdmin && !isAlreadySuperAdmin && (
              <div className="border-t border-zinc-800 pt-4">
                {!promoted && !showPromoteConfirm && (
                  <div className="rounded-lg border border-amber-800/50 bg-amber-900/10 px-4 py-3">
                    <div className="flex items-start gap-3">
                      <ShieldCheck className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-amber-200">Superadmin access</p>
                        <p className="mt-0.5 text-xs text-amber-200/70">
                          Grant this user system-wide superadmin access, including the
                          admin console at <span className="font-mono">/admin/</span>.
                        </p>
                      </div>
                      <button
                        onClick={() => { setPromoteError(null); setShowPromoteConfirm(true) }}
                        className="shrink-0 px-3 py-1.5 text-xs font-medium bg-amber-500 hover:bg-amber-400 text-black rounded-lg transition-colors"
                      >
                        Make Superadmin
                      </button>
                    </div>
                  </div>
                )}

                {/* Confirmation dialog */}
                {!promoted && showPromoteConfirm && (
                  <div className="rounded-lg border border-amber-700 bg-amber-900/20 px-4 py-4">
                    <p className="text-sm font-medium text-amber-100">
                      Make {userDisplayName} a superadmin?
                    </p>
                    <p className="mt-1 text-xs text-amber-200/80">
                      Superadmins have unrestricted, system-wide access across every group
                      and the admin console. This action is logged.
                    </p>
                    {promoteError && (
                      <p className="mt-2 text-xs text-red-400 bg-red-900/20 border border-red-800 rounded px-2 py-1.5">
                        {promoteError}
                      </p>
                    )}
                    <div className="flex justify-end gap-2 mt-3">
                      <button
                        onClick={() => setShowPromoteConfirm(false)}
                        disabled={promoting}
                        className="px-3 py-1.5 text-xs text-zinc-300 hover:text-white border border-zinc-700 hover:border-zinc-500 rounded-lg transition-colors disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => void handlePromoteToSuperAdmin()}
                        disabled={promoting}
                        className="px-3 py-1.5 text-xs font-medium bg-amber-500 hover:bg-amber-400 text-black rounded-lg transition-colors disabled:opacity-60"
                      >
                        {promoting ? 'Promoting…' : 'Confirm'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Promotion success message with onboarding instructions */}
            {promoted && (
              <div className="rounded-lg border border-emerald-800 bg-emerald-900/20 px-4 py-4">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-emerald-300">
                      {userDisplayName} is now a superadmin
                    </p>
                    <p className="mt-1 text-sm text-emerald-200/80">
                      Share these instructions with them:
                    </p>
                    <div className="mt-2 rounded-md border border-emerald-800/60 bg-emerald-950/40 px-3 py-2">
                      <p className="text-xs text-emerald-100/90 leading-relaxed">
                        You now have superadmin access on NavHub. Sign out and sign back in,
                        then open{' '}
                        <span className="font-mono text-emerald-100">
                          {(process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.navhub.co')}/admin/
                        </span>{' '}
                        to reach the admin console. The change takes effect after your next
                        login.
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.navhub.co'
                        navigator.clipboard?.writeText(
                          `You now have superadmin access on NavHub. Sign out and sign back in, ` +
                          `then open ${appUrl}/admin/ to reach the admin console. ` +
                          `The change takes effect after your next login.`,
                        )
                      }}
                      className="mt-2 text-xs text-emerald-300 hover:text-emerald-200 border border-emerald-700/50 hover:border-emerald-500 px-2.5 py-1 rounded transition-colors"
                    >
                      Copy instructions
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => { onSaved() }}
                className="px-4 py-2 text-sm font-medium bg-zinc-700 hover:bg-zinc-600 text-white rounded-lg transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
