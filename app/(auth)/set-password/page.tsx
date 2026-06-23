'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams }    from 'next/navigation'
import { Loader2 }            from 'lucide-react'
import { createClient }       from '@/lib/supabase/client'

// ── /set-password ───────────────────────────────────────────────────────────
// Two callers route here:
//   1. New-user invites — after /auth/callback exchanges the OTP and claims
//      the user's pending group_invites rows, it redirects to
//      ?invite=true so the invitee sets a password before landing.
//   2. Future password-reset flows that want a unified screen (the
//      existing /reset-password page is still in place; we don't touch it).
//
// The page assumes an authenticated session is already present (Supabase
// invite flow sets one before we arrive). It calls supabase.auth.updateUser
// to write the password, then forwards to /landing.

export default function SetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <SetPasswordInner />
    </Suspense>
  )
}

function SetPasswordInner() {
  const searchParams = useSearchParams()
  const isInvite     = searchParams.get('invite') === 'true'

  const [password, setPassword] = useState('')
  const [confirm,  setConfirm]  = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  // [diag] temporary — confirm the invite session survived the callback
  // redirect. Stripped after the green incognito run confirms the fix is live.
  useEffect(() => {
    const supabase = createClient()
    void supabase.auth.getSession().then(({ data }) => {
      console.log('[diag] set-password entry hasSession:', !!data.session)
    })
  }, [])

  async function handleSubmit() {
    setError(null)
    if (password.length < 8)       { setError('Password must be at least 8 characters'); return }
    if (password !== confirm)      { setError('Passwords do not match'); return }

    setLoading(true)
    try {
      const supabase = createClient()
      const { error: updateErr } = await supabase.auth.updateUser({ password })
      if (updateErr) throw updateErr
      window.location.href = '/landing'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set password')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <span className="text-2xl font-bold tracking-tight text-foreground">
            Nav<span style={{ color: 'var(--group-primary)' }}>Hub</span>
          </span>
        </div>

        <div className="rounded-xl border bg-card shadow-sm p-6 space-y-5">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-foreground">
              {isInvite ? 'Set up your account' : 'Set a new password'}
            </h2>
            <p className="text-sm text-muted-foreground">
              {isInvite
                ? 'Choose a password to complete your account setup.'
                : 'Enter a new password for your account.'}
            </p>
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoFocus
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Confirm password</label>
              <input
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="Repeat your password"
                onKeyDown={e => { if (e.key === 'Enter' && !loading) void handleSubmit() }}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          {error && (
            <div className="rounded-md bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          <button
            onClick={() => void handleSubmit()}
            disabled={loading || !password || !confirm}
            className="w-full py-2.5 bg-primary text-primary-foreground rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 inline-flex items-center justify-center gap-2"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {isInvite ? 'Set password & enter NavHub →' : 'Update password →'}
          </button>
        </div>

        {isInvite && (
          <p className="text-center text-xs text-muted-foreground">
            You can change your password anytime in account settings.
          </p>
        )}
      </div>
    </div>
  )
}
