'use client'

import { useState, useEffect, useCallback } from 'react'
import { Users, ChevronDown, Check, Mail, Shield, Crown } from 'lucide-react'
import { Button }   from '@/components/ui/button'
import { Input }    from '@/components/ui/input'
import { Badge }    from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { cn }       from '@/lib/utils'
import type { GroupMember, GroupInvite, AppRole } from '@/lib/types'
import { ADMIN_ROLES, canManageRole, canAssignRole } from '@/lib/permissions'
import PermissionsModal from './PermissionsModal'

const ROLE_OPTIONS = [
  { value: 'super_admin', label: 'Super Admin' },
  { value: 'group_owner', label: 'Owner'       },
  { value: 'group_admin', label: 'Group Admin' },
  { value: 'manager',     label: 'Manager'     },
  { value: 'viewer',      label: 'Viewer'      },
]

const ROLE_DISPLAY: Record<string, string> = {
  super_admin: 'Super Admin',
  group_owner: 'Owner',
  group_admin: 'Group Admin',
  manager:     'Manager',
  viewer:      'Viewer',
  // Legacy role labels for backwards compat display
  company_viewer:  'Viewer',
  division_viewer: 'Viewer',
}

// Roles the current user can assign in the dropdown — filters the global
// ROLE_OPTIONS down to what canAssignRole() allows. Drives both the invite
// form's role select and the per-member role select.
function assignableRoleOptions(currentRole: string) {
  return ROLE_OPTIONS.filter(r => canAssignRole(currentRole, r.value))
}

interface MembersTabProps {
  groupId:   string | null
  isAdmin:   boolean
  userId:    string
  userEmail: string
}

export default function MembersTab({ groupId, isAdmin, userId, userEmail }: MembersTabProps) {
  const [members,        setMembers]        = useState<GroupMember[]>([])
  const [invites,        setInvites]        = useState<GroupInvite[]>([])
  const [loading,        setLoading]        = useState(true)
  const [deleteConfirm,  setDeleteConfirm]  = useState<string | null>(null)
  const [cancelConfirm,  setCancelConfirm]  = useState<string | null>(null)
  const [roleSaving,     setRoleSaving]     = useState<string | null>(null)
  const [inviteEmail,    setInviteEmail]    = useState('')
  const [inviteName,     setInviteName]     = useState('')
  const [inviteRole,     setInviteRole]     = useState('viewer')
  // Caller's role on this group — drives super_admin protection in the UI
  // (group_admins should never see super_admin as an option, and never be
  // able to demote / remove an existing super_admin).
  const [callerRole,     setCallerRole]     = useState<string>('')
  const [permTarget,     setPermTarget]     = useState<{ id: string; email: string; role: AppRole } | null>(null)
  const [companies,      setCompanies]      = useState<{ id: string; name: string }[]>([])
  const [inviteSaving,   setInviteSaving]   = useState(false)
  const [inviteToast,    setInviteToast]    = useState<string | null>(null)

  const loadMembers = useCallback(async () => {
    if (!groupId) return
    setLoading(true)
    try {
      const [mRes, iRes, cRes, aRes] = await Promise.all([
        fetch(`/api/groups/${groupId}/members`),
        fetch(`/api/groups/${groupId}/invites`),
        fetch('/api/companies'),
        fetch('/api/groups/active'),
      ])
      const mJson = await mRes.json()
      const iJson = await iRes.json()
      const cJson = await cRes.json()
      const aJson = await aRes.json().catch(() => ({}))
      const callerRoleFromApi = (aJson.data as { role?: string } | undefined)?.role ?? ''
      setCallerRole(callerRoleFromApi)
      if (mJson.data) setMembers(mJson.data)
      // Defence-in-depth: API already filters by accepted_at IS NULL, but
      // strip any accepted rows here too in case of cache or RLS surprises.
      // Also strip any invites whose email matches an existing member —
      // catches stale rows where accepted_at was never written.
      const memberEmails = new Set(((mJson.data ?? []) as GroupMember[]).map(m => m.email.toLowerCase()))
      if (iJson.data) setInvites(
        (iJson.data as GroupInvite[]).filter(i => !i.accepted_at && !memberEmails.has(i.email.toLowerCase())),
      )
      if (cJson.data) setCompanies((cJson.data as Array<{ id: string; name: string; is_active: boolean }>).filter(c => c.is_active).map(c => ({ id: c.id, name: c.name })))
    } catch (err) { console.error('Members load error:', err) } finally {
      setLoading(false)
    }
  }, [groupId])

  useEffect(() => { void loadMembers() }, [loadMembers])

  // Refresh on window focus — catches the case where an invitee accepts in
  // another tab while this view is still open.
  useEffect(() => {
    function onFocus() { void loadMembers() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadMembers])

  // Auto-clear invite toast
  useEffect(() => {
    if (!inviteToast) return
    const t = setTimeout(() => setInviteToast(null), 3000)
    return () => clearTimeout(t)
  }, [inviteToast])

  async function handleRoleChange(memberId: string, newRole: string) {
    if (!groupId) return
    setRoleSaving(memberId)
    try {
      const res  = await fetch(`/api/groups/${groupId}/members/${memberId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ role: newRole }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to update role')
      setMembers(ms => ms.map(m => m.user_id === memberId ? { ...m, role: newRole } : m))
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update role')
    } finally {
      setRoleSaving(null)
    }
  }

  async function handleRemoveMember(memberId: string) {
    if (!groupId) return
    try {
      const res  = await fetch(`/api/groups/${groupId}/members/${memberId}`, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to remove member')
      setMembers(ms => ms.filter(m => m.user_id !== memberId))
      setDeleteConfirm(null)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to remove member')
      setDeleteConfirm(null)
    }
  }

  async function handleResendInvite(inviteId: string, email: string) {
    if (!groupId) return
    try {
      const res  = await fetch(`/api/groups/${groupId}/invites/${inviteId}/resend`, { method: 'POST' })
      const json = await res.json() as { error?: string }
      if (!res.ok) throw new Error(json.error ?? 'Failed to resend invite')
      setInviteToast(`Invite resent to ${email}`)
    } catch (err) {
      setInviteToast(err instanceof Error ? err.message : 'Failed to resend invite')
    }
  }

  async function handleCancelInvite(inviteId: string) {
    if (!groupId) return
    try {
      const res  = await fetch(`/api/groups/${groupId}/invites/${inviteId}`, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to cancel invite')
      setInvites(is => is.filter(i => i.id !== inviteId))
      setCancelConfirm(null)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to cancel invite')
      setCancelConfirm(null)
    }
  }

  async function handleSendInvite() {
    if (!groupId) return
    const email = inviteEmail.trim().toLowerCase()
    if (!email.includes('@')) { setInviteToast('Enter a valid email address'); return }
    setInviteSaving(true)
    try {
      const res  = await fetch(`/api/groups/${groupId}/invites`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          email,
          role: inviteRole,
          full_name: inviteName.trim() || undefined,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to send invite')
      setInvites(is => {
        const existing = is.findIndex(i => i.email === email)
        if (existing >= 0) return is.map((i, idx) => idx === existing ? json.data : i)
        return [...is, json.data]
      })
      setInviteEmail('')
      setInviteName('')
      setInviteToast(`Invite recorded for ${email}`)
    } catch (err) {
      setInviteToast(err instanceof Error ? err.message : 'Failed to invite')
    } finally {
      setInviteSaving(false)
    }
  }

  if (!isAdmin) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <Users className="h-8 w-8 mx-auto mb-2 text-muted-foreground opacity-40" />
          <p className="text-sm text-muted-foreground">Only group administrators can manage members.</p>
        </CardContent>
      </Card>
    )
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {[...Array(3)].map((_, i) => <div key={i} className="h-12 rounded-lg bg-muted animate-pulse" />)}
      </div>
    )
  }

  return (
    <div className="space-y-5">

      {/* ── Invite form ──────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4 text-muted-foreground" />
            Invite a Member
          </CardTitle>
          <CardDescription>
            Record an email and role. Share the app URL — their access applies when they sign in.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr,1fr,auto,auto] gap-2">
            <Input
              value={inviteName}
              onChange={e => setInviteName(e.target.value)}
              placeholder="Full name (optional)"
              onKeyDown={e => { if (e.key === 'Enter') void handleSendInvite() }}
            />
            <Input
              type="email"
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              placeholder="name@example.com"
              onKeyDown={e => { if (e.key === 'Enter') void handleSendInvite() }}
            />
            <div className="relative">
              <select
                value={inviteRole}
                onChange={e => setInviteRole(e.target.value)}
                className="appearance-none h-9 rounded-md border border-input bg-background pl-2 pr-7 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {/* Invite form: never offer super_admin or group_owner here. Owners
                    are minted by direct PATCH on the members route (super_admin only). */}
                {ROLE_OPTIONS
                  .filter(r => r.value !== 'super_admin' && r.value !== 'group_owner')
                  .map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <Button size="sm" onClick={handleSendInvite} disabled={inviteSaving}>
              {inviteSaving ? 'Saving…' : 'Invite'}
            </Button>
          </div>
          {inviteToast && (
            <p className={cn(
              'text-xs flex items-center gap-1',
              inviteToast.startsWith('Invite recorded') ? 'text-green-600 dark:text-green-400' : 'text-destructive'
            )}>
              {inviteToast.startsWith('Invite recorded') && <Check className="h-3.5 w-3.5" />}
              {inviteToast}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Members list ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            Members
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              {members.length} member{members.length !== 1 ? 's' : ''}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {members.length === 0 ? (
            <p className="px-6 py-4 text-sm text-muted-foreground">No members found.</p>
          ) : (
            <ul className="divide-y">
              {members.map(member => {
                const isYou = member.user_id === userId
                return (
                  <li key={member.user_id} className="flex items-center gap-3 px-6 py-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-medium text-foreground truncate">{member.email}</p>
                        {isYou && (
                          <Badge variant="outline" className="text-xs shrink-0">You</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {ROLE_DISPLAY[member.role] ?? member.role}
                        {' · '}Joined {new Date(member.joined_at).toLocaleDateString('en-AU')}
                      </p>
                    </div>

                    {/* Read-only Super Admin badge — never editable from this UI */}
                    {member.role === 'super_admin' && (
                      <Badge className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 border-0">
                        <Shield className="h-3 w-3 mr-1" /> Super Admin
                      </Badge>
                    )}

                    {/* Owner badge — non-editable for everyone except super_admin */}
                    {member.role === 'group_owner' && (
                      <Badge className="text-xs bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border-0">
                        <Crown className="h-3 w-3 mr-1" /> Owner
                      </Badge>
                    )}

                    {/* Role selector — only rendered when the caller is allowed to
                         manage this member. canManageRole encodes the full hierarchy:
                         super_admin → anyone except other super_admins; group_owner →
                         group_admin and below; group_admin → manager / viewer only. */}
                    {!isYou && canManageRole(callerRole, member.role) && (
                      <div className="relative">
                        <select
                          value={member.role}
                          disabled={roleSaving === member.user_id}
                          onChange={e => void handleRoleChange(member.user_id, e.target.value)}
                          className="appearance-none h-8 rounded-md border border-input bg-background pl-2 pr-7 text-xs text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                        >
                          {/* Always include the member's current role so it stays
                              selected even if the caller can't reassign to it. Plus
                              every role the caller is allowed to assign. */}
                          {Array.from(new Set([
                            member.role,
                            ...assignableRoleOptions(callerRole).map(o => o.value),
                          ])).map(value => (
                            <option key={value} value={value}>
                              {ROLE_DISPLAY[value] ?? value}
                            </option>
                          ))}
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-1.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                    )}

                    {/* Manage access — only for non-admin members */}
                    {!isYou && !ADMIN_ROLES.includes(member.role as AppRole) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1 px-2"
                        onClick={() => setPermTarget({ id: member.user_id, email: member.email, role: member.role as AppRole })}
                      >
                        <Shield className="h-3 w-3" /> Access
                      </Button>
                    )}

                    {/* Remove — same hierarchy gate as the role selector. */}
                    {!isYou && canManageRole(callerRole, member.role) && (
                      deleteConfirm === member.user_id ? (
                        <span className="flex items-center gap-1 text-xs">
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-7 text-xs px-2"
                            onClick={() => void handleRemoveMember(member.user_id)}
                          >
                            Confirm
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs px-2"
                            onClick={() => setDeleteConfirm(null)}
                          >
                            Cancel
                          </Button>
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs px-2 text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteConfirm(member.user_id)}
                        >
                          Remove
                        </Button>
                      )
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── Pending invites ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pending Invites</CardTitle>
          <CardDescription>
            These invites are recorded. Share the app URL with the invited person.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {invites.filter(i => !i.accepted_at).length === 0 ? (
            <p className="px-6 py-4 text-sm text-muted-foreground">No pending invites.</p>
          ) : (
            <ul className="divide-y">
              {invites.filter(i => !i.accepted_at).map(invite => (
                <li key={invite.id} className="flex items-center gap-3 px-6 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{invite.email}</p>
                    <p className="text-xs text-muted-foreground capitalize">
                      {ROLE_DISPLAY[invite.role] ?? invite.role}
                      {' · '}Invited {new Date(invite.created_at).toLocaleDateString('en-AU')}
                    </p>
                  </div>
                  {cancelConfirm === invite.id ? (
                    <span className="flex items-center gap-1 text-xs">
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-7 text-xs px-2"
                        onClick={() => void handleCancelInvite(invite.id)}
                      >
                        Cancel invite
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs px-2"
                        onClick={() => setCancelConfirm(null)}
                      >
                        Keep
                      </Button>
                    </span>
                  ) : (
                    <span className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs px-2 text-muted-foreground hover:text-foreground"
                        onClick={() => void handleResendInvite(invite.id, invite.email)}
                        title="Resend invite email"
                      >
                        Resend
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs px-2 text-muted-foreground hover:text-destructive"
                        onClick={() => setCancelConfirm(invite.id)}
                      >
                        Revoke
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── Account info ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your Account</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Email: <span className="font-medium text-foreground">{userEmail || '—'}</span></p>
        </CardContent>
      </Card>

      {/* Permissions Modal */}
      {permTarget && groupId && (
        <PermissionsModal
          userId={permTarget.id}
          groupId={groupId}
          email={permTarget.email}
          role={permTarget.role}
          companies={companies}
          onSave={() => void loadMembers()}
          onClose={() => setPermTarget(null)}
        />
      )}
    </div>
  )
}
