'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import UserFormModal from '@/components/admin/UserFormModal'

interface UserRow {
  id:              string
  email:           string
  created_at:      string
  last_sign_in_at: string | null
  groups:          { group_id: string; group_name: string; role: string; is_default: boolean }[]
}

function fmtDate(s: string | null) {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })
}

const ROLES = ['all', 'super_admin', 'group_admin', 'manager', 'viewer']

export default function AdminUsersPage() {
  const [users,       setUsers]       = useState<UserRow[]>([])
  const [search,      setSearch]      = useState('')
  const [role,        setRole]        = useState('all')
  const [loading,     setLoading]     = useState(true)
  const [showModal,   setShowModal]   = useState(false)
  const [editUser,    setEditUser]    = useState<{ id: string; email: string; group_id: string; role: string; memberships?: { group_id: string; group_name: string; role: string; is_default: boolean }[] } | undefined>()
  const [resetLinks,  setResetLinks]  = useState<Record<string, string>>({})
  const [resetting,   setResetting]   = useState<Record<string, boolean>>({})

  function loadUsers() {
    setLoading(true)
    fetch('/api/admin/users')
      .then(r => r.json())
      .then(json => setUsers((json.data ?? []) as UserRow[]))
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadUsers() }, [])

  const filtered = useMemo(() => {
    let list = users
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(u => u.email.toLowerCase().includes(q))
    }
    if (role !== 'all') {
      list = list.filter(u => u.groups.some(g => g.role === role))
    }
    return list
  }, [users, search, role])

  function openNew() {
    setEditUser(undefined)
    setShowModal(true)
  }

  function openEdit(u: UserRow) {
    const first = u.groups[0]
    setEditUser({
      id: u.id,
      email: u.email,
      group_id: first?.group_id ?? '',
      role: first?.role ?? 'viewer',
      memberships: u.groups,
    })
    setShowModal(true)
  }

  function handleSaved() {
    setShowModal(false)
    loadUsers()
  }

  async function sendResetLink(userId: string) {
    setResetting(prev => ({ ...prev, [userId]: true }))
    try {
      const res = await fetch(`/api/admin/users/${userId}/reset-password`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      setResetLinks(prev => ({ ...prev, [userId]: json.data?.reset_link ?? '' }))
    } catch (err) {
      alert((err as Error).message)
    } finally {
      setResetting(prev => ({ ...prev, [userId]: false }))
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Users</h1>
          <p className="text-zinc-400 text-sm mt-1">All users across all groups.</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={role}
            onChange={e => setRole(e.target.value)}
            className="h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
          >
            {ROLES.map(r => (
              <option key={r} value={r}>{r === 'all' ? 'All roles' : r.replace(/_/g, ' ')}</option>
            ))}
          </select>
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by email…"
            className="w-64 h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
          />
          <button
            onClick={openNew}
            className="inline-flex items-center gap-1.5 h-9 px-3 text-sm font-medium bg-amber-500 hover:bg-amber-400 text-black rounded-md transition-colors"
          >
            <Plus className="h-4 w-4" />
            New User
          </button>
        </div>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-xs text-zinc-500 uppercase tracking-wide">
              <th className="px-5 py-3 text-left">Email</th>
              <th className="px-5 py-3 text-left">Groups &amp; Roles</th>
              <th className="px-5 py-3 text-left">Created</th>
              <th className="px-5 py-3 text-left">Last Sign In</th>
              <th className="px-5 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {loading && (
              <tr><td colSpan={5} className="px-5 py-8 text-center text-zinc-500">Loading…</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={5} className="px-5 py-8 text-center text-zinc-500">No users found.</td></tr>
            )}
            {filtered.map(u => (
              <tr key={u.id} className="hover:bg-zinc-800/40 transition-colors">
                <td className="px-5 py-3 text-white font-mono text-xs">{u.email}</td>
                <td className="px-5 py-3">
                  <div className="flex flex-wrap gap-1">
                    {u.groups.length === 0 && (
                      <span className="text-xs text-zinc-600 italic">No groups</span>
                    )}
                    {u.groups.map(g => (
                      <Link
                        key={g.group_id}
                        href={`/admin/groups/${g.group_id}`}
                        className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
                      >
                        <span>{g.group_name}</span>
                        <span className="text-zinc-500">·</span>
                        <span className="capitalize">{g.role.replace(/_/g, ' ')}</span>
                      </Link>
                    ))}
                  </div>
                </td>
                <td className="px-5 py-3 text-zinc-400">{fmtDate(u.created_at)}</td>
                <td className="px-5 py-3 text-zinc-400">{fmtDate(u.last_sign_in_at)}</td>
                <td className="px-5 py-3 text-right">
                  <div className="flex items-center justify-end gap-2 flex-wrap">
                    {resetLinks[u.id] ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-green-400">Link ready</span>
                        <button
                          onClick={() => { navigator.clipboard.writeText(resetLinks[u.id]); }}
                          className="text-xs text-amber-400 hover:text-amber-300 border border-amber-700/50 hover:border-amber-500 px-2.5 py-1 rounded transition-colors"
                        >
                          Copy
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => sendResetLink(u.id)}
                        disabled={resetting[u.id]}
                        className="text-xs text-zinc-400 hover:text-amber-300 border border-zinc-700 hover:border-amber-700/50 px-2.5 py-1 rounded transition-colors disabled:opacity-50"
                      >
                        {resetting[u.id] ? 'Sending…' : 'Reset Password'}
                      </button>
                    )}
                    <button
                      onClick={() => openEdit(u)}
                      className="text-xs text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 px-2.5 py-1 rounded transition-colors"
                    >
                      Edit
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!loading && (
        <p className="text-xs text-zinc-600">{filtered.length} of {users.length} users</p>
      )}

      {showModal && (
        <UserFormModal
          user={editUser}
          onClose={() => { setShowModal(false); loadUsers() }}
          onSaved={handleSaved}
          // This page lives under the superadmin-gated /admin area (enforced by
          // middleware + layout), so the viewer is always a superadmin here.
          isSuperAdmin
        />
      )}
    </div>
  )
}
