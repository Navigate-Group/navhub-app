'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { signIn } from '../actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

// ── /login ──────────────────────────────────────────────────────────────────
// Email + password sign-in form. When the user arrives from a broken or
// expired invite link, /auth/callback redirects here with ?error=missing_code
// or ?error=auth_failed. In that case we surface an explanation above the form
// and offer a "Send me a new invite" flow that POSTs the email to
// /api/invite/request (anti-enumeration: that endpoint always returns success).

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
  const error        = searchParams.get('error')
  const hasInviteError = error === 'missing_code' || error === 'auth_failed'

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

        {hasInviteError && <InviteErrorCard invitedEmail={invitedEmail} />}

        <SignInView />
      </div>
    </div>
  )
}

// ── Expired / broken invite notice + request-new-invite flow ────────────────

function InviteErrorCard({ invitedEmail }: { invitedEmail: string }) {
  const [email, setEmail]     = useState(invitedEmail)
  const [loading, setLoading] = useState(false)
  const [sent, setSent]       = useState(false)

  async function handleRequest() {
    if (!email.includes('@')) return
    setLoading(true)
    try {
      // /api/invite/request always returns a neutral success (no account
      // disclosure), so we show the same confirmation regardless of outcome.
      await fetch('/api/invite/request', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: email.trim().toLowerCase() }),
      })
    } catch {
      // Stay neutral — never reveal failures to the user.
    } finally {
      setLoading(false)
      setSent(true)
    }
  }

  return (
    <Card className="mb-4 border-destructive/40">
      <CardContent className="pt-6 space-y-4">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            Your invite link has expired or didn&apos;t work
          </p>
          <p className="text-sm text-muted-foreground">
            Enter your email and we&apos;ll send you a fresh invite link.
          </p>
        </div>

        {sent ? (
          <p className="text-sm text-muted-foreground">
            If there&apos;s an invite for this email, we&apos;ve sent you a new
            link. If nothing arrives in a few minutes, ask your NavHub
            administrator to invite you.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <Button
              type="button"
              className="w-full"
              disabled={loading || !email.includes('@')}
              onClick={() => void handleRequest()}
            >
              {loading ? 'Sending…' : 'Send me a new invite'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Sign In ─────────────────────────────────────────────────────────────────

function SignInView() {
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
      </CardContent>
    </Card>
  )
}
