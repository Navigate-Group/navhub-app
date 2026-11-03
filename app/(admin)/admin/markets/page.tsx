'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface MarketsUserRow {
  user_id:    string
  email:      string
  roles:      Array<'markets_viewer' | 'markets_manager'>
  granted_at: string
}

type MarketsRole = 'markets_viewer' | 'markets_manager'

const ROLE_LABELS: Record<MarketsRole, string> = {
  markets_viewer:  'Viewer',
  markets_manager: 'Manager',
}

function fmtDate(s: string | null) {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function AdminMarketsPage() {
  const [users,   setUsers]   = useState<MarketsUserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy,    setBusy]    = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  // Invite / grant form state
  const [email, setEmail] = useState('')
  const [role,  setRole]  = useState<MarketsRole>('markets_viewer')

  function load() {
    setLoading(true)
    fetch('/api/admin/markets')
      .then(r => r.json())
      .then(json => setUsers((json.data ?? []) as MarketsUserRow[]))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  async function grant(payload: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    try {
      const res  = await fetch('/api/admin/markets', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      load()
      return json
    } catch (err) {
      setError((err as Error).message)
      return null
    } finally {
      setBusy(false)
    }
  }

  async function revoke(userId: string, r: MarketsRole) {
    setBusy(true)
    setError(null)
    try {
      const res  = await fetch('/api/admin/markets', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ user_id: userId, role: r }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function submitInvite(e: React.FormEvent) {
    e.preventDefault()
    const result = await grant({ email: email.trim().toLowerCase(), role })
    if (result) setEmail('')
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-white">Markets Access</h1>
          <p className="text-zinc-400 text-sm mt-1">
            Grant or revoke Markets roles and invite users to Markets. Super admins always have full access.
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href="/admin/markets/agents" className="text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 px-3 py-1.5 rounded transition-colors">Agent config</Link>
          <Link href="/admin/markets/usage" className="text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 px-3 py-1.5 rounded transition-colors">Usage</Link>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-800 bg-red-950/40 px-4 py-2 text-sm text-red-300">{error}</div>
      )}

      {/* Invite / grant by email */}
      <form onSubmit={submitInvite} className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-semibold text-white">Invite or grant access</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[220px]">
            <label className="block text-xs text-zinc-500 mb-1">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="person@company.com"
              className="w-full h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Role</label>
            <select
              value={role}
              onChange={e => setRole(e.target.value as MarketsRole)}
              className="h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
            >
              <option value="markets_viewer">Viewer</option>
              <option value="markets_manager">Manager</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={busy}
            className="h-9 px-4 text-sm font-medium bg-amber-500 hover:bg-amber-400 text-black rounded-md transition-colors disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Grant / Invite'}
          </button>
        </div>
        <p className="text-xs text-zinc-600">
          Existing NavHub users are granted access immediately. New emails receive a passwordless invitation.
        </p>
      </form>

      {/* Current Markets users */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-xs text-zinc-500 uppercase tracking-wide">
              <th className="px-5 py-3 text-left">Email</th>
              <th className="px-5 py-3 text-left">Roles</th>
              <th className="px-5 py-3 text-left">Granted</th>
              <th className="px-5 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {loading && (
              <tr><td colSpan={4} className="px-5 py-8 text-center text-zinc-500">Loading…</td></tr>
            )}
            {!loading && users.length === 0 && (
              <tr><td colSpan={4} className="px-5 py-8 text-center text-zinc-500">No Markets users yet.</td></tr>
            )}
            {users.map(u => {
              const hasManager = u.roles.includes('markets_manager')
              const hasViewer  = u.roles.includes('markets_viewer')
              return (
                <tr key={u.user_id} className="hover:bg-zinc-800/40 transition-colors">
                  <td className="px-5 py-3 text-white font-mono text-xs">{u.email || u.user_id}</td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap gap-1">
                      {u.roles.map(r => (
                        <span key={r} className="text-xs px-2 py-0.5 rounded-full bg-zinc-700 text-zinc-300">
                          {ROLE_LABELS[r]}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-zinc-400">{fmtDate(u.granted_at)}</td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-2 flex-wrap">
                      {!hasManager && (
                        <button
                          onClick={() => grant({ user_id: u.user_id, role: 'markets_manager' })}
                          disabled={busy}
                          className="text-xs text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 px-2.5 py-1 rounded transition-colors disabled:opacity-50"
                        >
                          Make Manager
                        </button>
                      )}
                      {!hasViewer && (
                        <button
                          onClick={() => grant({ user_id: u.user_id, role: 'markets_viewer' })}
                          disabled={busy}
                          className="text-xs text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 px-2.5 py-1 rounded transition-colors disabled:opacity-50"
                        >
                          Make Viewer
                        </button>
                      )}
                      {u.roles.map(r => (
                        <button
                          key={r}
                          onClick={() => revoke(u.user_id, r)}
                          disabled={busy}
                          className="text-xs text-red-400 hover:text-red-300 border border-red-900/50 hover:border-red-700 px-2.5 py-1 rounded transition-colors disabled:opacity-50"
                        >
                          Revoke {ROLE_LABELS[r]}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
