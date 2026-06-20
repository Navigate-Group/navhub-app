'use client'

import { Suspense, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { signIn } from '../actions'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

// ── /login ──────────────────────────────────────────────────────────────────
// A single rendered page with three in-place view states:
//   • sign-in — existing email + password sign-in form
//   • set-up  — self-service account setup for invitees (locked email from the
//               ?email= query param, set/confirm password + strength meter).
//               Calls supabase.auth.updateUser({ password }), the same path the
//               post-OTP /set-password page uses; it requires an active session.
//   • success — brief confirmation, then back to sign-in.
// No navigations between views — everything is React state on the same page.

type View = 'sign-in' | 'set-up' | 'success'

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  )
}

function LoginInner() {
  const searchParams = useSearchParams()
  const invitedEmail = searchParams.get('email') ?? ''
  // New invitees are redirected here from /auth/callback as
  // /login?setup=true&email=… once their invite OTP is exchanged. Open the
  // Set Up Account form directly so they can choose a password using the live
  // session established by that exchange.
  const isSetup = searchParams.get('setup') === 'true'

  const [view, setView] = useState<View>(isSetup ? 'set-up' : 'sign-in')

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">
        {/* NavHub wordmark */}
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            Nav<span style={{ color: 'var(--group-primary)' }}>Hub</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Financial performance, at a glance
          </p>
        </div>

        {view === 'sign-in' && (
          <SignInView onSetUp={() => setView('set-up')} />
        )}
        {view === 'set-up' && (
          <SetUpView
            invitedEmail={invitedEmail}
            onBack={() => setView('sign-in')}
            onSuccess={() => setView('success')}
          />
        )}
        {view === 'success' && (
          <SuccessView onBack={() => setView('sign-in')} />
        )}
      </div>
    </div>
  )
}

// ── Sign In ─────────────────────────────────────────────────────────────────

function SignInView({ onSetUp }: { onSetUp: () => void }) {
  const [error, setError]     = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const formData = new FormData(e.currentTarget)
    const result   = await signIn(formData)

    if (result?.error) {
      setError(result.error)
      setLoading(false)
    }
    // On success, signIn() redirects — no need to handle here
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <p className="text-sm text-center text-muted-foreground">
          Sign in to your account
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link
                href="/forgot-password"
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Forgot password?
              </Link>
            </div>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              placeholder="••••••••"
            />
          </div>

          {error && (
            <p className="text-sm text-destructive text-center">{error}</p>
          )}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          New here?{' '}
          <button
            type="button"
            onClick={onSetUp}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Set up your account
          </button>
        </p>
      </CardContent>
    </Card>
  )
}

// ── Set Up Account ──────────────────────────────────────────────────────────

type Strength = { score: 0 | 1 | 2 | 3; label: 'Weak' | 'Fair' | 'Strong' }

function passwordStrength(password: string): Strength {
  if (!password) return { score: 0, label: 'Weak' }

  let variety = 0
  if (/[a-z]/.test(password)) variety++
  if (/[A-Z]/.test(password)) variety++
  if (/[0-9]/.test(password)) variety++
  if (/[^A-Za-z0-9]/.test(password)) variety++

  const long = password.length >= 12
  const mediumLength = password.length >= 8

  // Strong: 12+ chars with at least 3 character classes, or 8+ with all 4
  if ((long && variety >= 3) || (mediumLength && variety >= 4)) {
    return { score: 3, label: 'Strong' }
  }
  // Fair: at least 8 chars with some variety
  if (mediumLength && variety >= 2) {
    return { score: 2, label: 'Fair' }
  }
  return { score: 1, label: 'Weak' }
}

function SetUpView({
  invitedEmail,
  onBack,
  onSuccess,
}: {
  invitedEmail: string
  onBack: () => void
  onSuccess: () => void
}) {
  const [email, setEmail]       = useState(invitedEmail)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm]   = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)

  const strength = useMemo(() => passwordStrength(password), [password])

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }

    setLoading(true)
    try {
      const supabase = createClient()

      // updateUser requires an active session, established by the invite OTP
      // exchange. If the user arrived directly, there is no session to update.
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        setError(
          'No active invite session was found. Please open the link from your invite email to set up your account.'
        )
        setLoading(false)
        return
      }

      // Set the password AND stamp a flag so /auth/callback no longer treats
      // this invitee as needing setup on future invite/magic-link sign-ins
      // (the `invited_at` marker on the auth record is permanent).
      const { error: updateErr } = await supabase.auth.updateUser({
        password,
        data: { password_set: true },
      })
      if (updateErr) throw updateErr

      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set up account')
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-4 space-y-3">
        <button
          type="button"
          onClick={onBack}
          className="self-start text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          ← Back to sign in
        </button>
        <p className="text-sm text-center text-muted-foreground">
          Set up your account
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="setup-email">Email</Label>
            <Input
              id="setup-email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="setup-password">Set password</Label>
            <Input
              id="setup-password"
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              placeholder="At least 8 characters"
            />
            {password && (
              <div className="space-y-1 pt-1">
                <div className="flex gap-1" aria-hidden="true">
                  {[1, 2, 3].map(bar => (
                    <div
                      key={bar}
                      className={`h-1 flex-1 rounded-full transition-colors ${
                        strength.score >= bar
                          ? strength.label === 'Strong'
                            ? 'bg-green-500'
                            : strength.label === 'Fair'
                            ? 'bg-yellow-500'
                            : 'bg-destructive'
                          : 'bg-muted'
                      }`}
                    />
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Password strength:{' '}
                  <span
                    className={
                      strength.label === 'Strong'
                        ? 'text-green-500'
                        : strength.label === 'Fair'
                        ? 'text-yellow-500'
                        : 'text-destructive'
                    }
                  >
                    {strength.label}
                  </span>
                </p>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="setup-confirm">Confirm password</Label>
            <Input
              id="setup-confirm"
              name="confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              required
              placeholder="Repeat your password"
            />
          </div>

          {error && (
            <p className="text-sm text-destructive text-center">{error}</p>
          )}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Setting up…' : 'Set up account'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

// ── Success ─────────────────────────────────────────────────────────────────

function SuccessView({ onBack }: { onBack: () => void }) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <button
          type="button"
          onClick={onBack}
          className="self-start text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          ← Back to sign in
        </button>
      </CardHeader>
      <CardContent className="space-y-4 text-center">
        <p className="text-sm font-medium text-foreground">
          Your account is all set up.
        </p>
        <p className="text-sm text-muted-foreground">
          You can now sign in with your email and new password.
        </p>
        <Button type="button" className="w-full" onClick={onBack}>
          Back to sign in
        </Button>
      </CardContent>
    </Card>
  )
}
