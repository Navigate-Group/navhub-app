'use client'

import { useState } from 'react'
import Link from 'next/link'

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  group_admin: 'Group Admin',
  manager:     'Manager',
  viewer:      'Viewer',
}

interface Props {
  token:              string
  email:              string
  groupName:          string
  role:               string
  fullName:           string | null
  isUsed:             boolean
  isExpired:          boolean
  isInvalid:          boolean
  hasExistingAccount: boolean
}

export default function InviteAcceptClient({
  token, email, groupName, role, fullName, isUsed, isExpired, isInvalid, hasExistingAccount,
}: Props) {
  const [accepting, setAccepting] = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  async function handleAccept() {
    setAccepting(true)
    setError(null)
    try {
      const res  = await fetch(`/api/invite/${token}/accept`, { method: 'POST' })
      const json = await res.json() as { redirectUrl?: string; error?: string }
      if (!res.ok || !json.redirectUrl) {
        throw new Error(json.error ?? 'Failed to accept invite')
      }
      // The action_link only ever exists in this function's local scope and
      // the POST response body — never in HTML the scanner can fetch.
      window.location.href = json.redirectUrl
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setAccepting(false)
    }
  }

  if (isInvalid) {
    return (
      <InviteLayout>
        <div className="text-center space-y-3">
          <div className="text-4xl">🔗</div>
          <h2 className="text-lg font-semibold text-foreground">This link is no longer valid</h2>
          <p className="text-sm text-muted-foreground">
            This invitation link can&apos;t be found. It may have been cancelled or replaced with a newer one.
          </p>
          <BrokenStateActions email={email} hasExistingAccount={hasExistingAccount} />
        </div>
      </InviteLayout>
    )
  }

  if (isUsed) {
    return (
      <InviteLayout>
        <div className="text-center space-y-3">
          <div className="text-4xl">✅</div>
          <h2 className="text-lg font-semibold text-foreground">Already accepted</h2>
          <p className="text-sm text-muted-foreground">
            This invitation has already been used.
          </p>
          <BrokenStateActions email={email} hasExistingAccount={hasExistingAccount} />
        </div>
      </InviteLayout>
    )
  }

  if (isExpired) {
    return (
      <InviteLayout>
        <div className="text-center space-y-3">
          <div className="text-4xl">⏰</div>
          <h2 className="text-lg font-semibold text-foreground">Invitation expired</h2>
          <p className="text-sm text-muted-foreground">
            This invitation link has expired. Request a fresh one below.
          </p>
          <BrokenStateActions email={email} hasExistingAccount={hasExistingAccount} />
        </div>
      </InviteLayout>
    )
  }

  return (
    <InviteLayout>
      <div className="space-y-6">
        <div className="text-center space-y-1">
          <div className="text-4xl mb-3">👋</div>
          <h2 className="text-xl font-semibold text-foreground">You&apos;ve been invited</h2>
          <p className="text-sm text-muted-foreground">
            {fullName ? `Hi ${fullName.split(' ')[0]}, you've` : "You've"} been invited to join
          </p>
        </div>

        <div className="rounded-lg border bg-muted/30 p-4 space-y-2 text-sm">
          <Row label="Group" value={groupName} />
          <Row label="Role"  value={ROLE_LABELS[role] ?? role.replace(/_/g, ' ')} />
          <Row label="Email" value={email} />
        </div>

        {error && (
          <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:border-red-800 dark:text-red-300">
            {error}
          </div>
        )}

        <button
          onClick={handleAccept}
          disabled={accepting}
          className="w-full py-2.5 px-4 bg-primary text-primary-foreground rounded-lg font-medium text-sm hover:opacity-90 disabled:opacity-50 inline-flex items-center justify-center gap-2"
        >
          {accepting ? (
            <>
              <span className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Setting up your account…
            </>
          ) : (
            <>Accept invitation → Join {groupName}</>
          )}
        </button>

        <p className="text-center text-xs text-muted-foreground">
          By accepting you agree to NavHub&apos;s terms of service.
        </p>
      </div>
    </InviteLayout>
  )
}

// Contextual next-steps shown on every broken/terminal state (invalid,
// already-used, expired). The available actions depend on whether the
// invitee's email already maps to a Supabase account:
//   • existing account → "Log in with existing credentials" + "Request a new invite"
//   • no account       → "Request a new invite" only
// "Request a new invite" POSTs to /api/invite/request, which returns a
// neutral success regardless of whether the email was found (no enumeration).
function BrokenStateActions({
  email, hasExistingAccount,
}: {
  email: string
  hasExistingAccount: boolean
}) {
  const [requesting, setRequesting] = useState(false)
  const [done,       setDone]       = useState(false)

  async function handleRequest() {
    setRequesting(true)
    try {
      await fetch('/api/invite/request', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email }),
      })
    } catch {
      // Swallow — the endpoint is intentionally neutral and we never reveal
      // whether the email exists. Always show the same confirmation below.
    } finally {
      setRequesting(false)
      setDone(true)
    }
  }

  if (done) {
    return (
      <p className="mt-4 text-sm text-foreground">
        Check your inbox — a new invite is on its way.
      </p>
    )
  }

  return (
    <div className="mt-4 space-y-2">
      {hasExistingAccount && (
        <Link
          href="/login"
          className="block w-full py-2.5 px-4 bg-primary text-primary-foreground rounded-lg font-medium text-sm hover:opacity-90 text-center"
        >
          Log in with existing credentials
        </Link>
      )}
      <button
        onClick={handleRequest}
        disabled={requesting}
        className="block w-full py-2.5 px-4 rounded-lg font-medium text-sm border border-input bg-background text-foreground hover:bg-muted/50 disabled:opacity-50 text-center"
      >
        {requesting ? 'Sending…' : 'Request a new invite'}
      </button>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground truncate">{value}</span>
    </div>
  )
}

function InviteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <span className="text-2xl font-bold tracking-tight text-foreground">
            Nav<span style={{ color: 'var(--group-primary)' }}>Hub</span>
          </span>
        </div>
        <div className="rounded-xl border bg-card shadow-sm p-6">
          {children}
        </div>
      </div>
    </div>
  )
}
