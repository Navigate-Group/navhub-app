'use client'

import { useState, useEffect }            from 'react'
import { useRouter }                      from 'next/navigation'
import { createClient }                   from '@/lib/supabase/client'
import { Card, CardContent, CardHeader }  from '@/components/ui/card'
import { Button }                         from '@/components/ui/button'
import { Input }                          from '@/components/ui/input'
import { Label }                          from '@/components/ui/label'
import { PasswordVisibilityToggle }       from '@/components/ui/password-visibility-toggle'

export default function ResetPasswordPage() {
  const router   = useRouter()
  const supabase = createClient()

  const [password,        setPassword]        = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error,           setError]           = useState<string | null>(null)
  const [loading,         setLoading]         = useState(false)
  const [sessionReady,    setSessionReady]    = useState(false)
  const [showPassword,    setShowPassword]    = useState(false)
  const [showConfirm,     setShowConfirm]     = useState(false)

  // Supabase recovery links set a RECOVERY session via the hash fragment.
  // onAuthStateChange fires with 'PASSWORD_RECOVERY' or 'SIGNED_IN'.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') {
        setSessionReady(true)
      }
    })

    // Also handle already-loaded sessions (e.g. page refresh)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setSessionReady(true)
    })

    return () => subscription.unsubscribe()
  }, [supabase])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    try {
      const { error: updateErr } = await supabase.auth.updateUser({ password })
      if (updateErr) { setError(updateErr.message); return }
      router.replace('/dashboard')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">
        {/* NavHub wordmark */}
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            Nav<span style={{ color: 'var(--group-primary)' }}>Hub</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Set a new password
          </p>
        </div>

        <Card>
          <CardHeader className="pb-4">
            <p className="text-sm text-center text-muted-foreground">
              {sessionReady ? 'Choose a strong password' : 'Verifying reset link…'}
            </p>
          </CardHeader>
          <CardContent>
            {!sessionReady ? (
              <div className="py-6 text-center text-muted-foreground text-sm">
                Please wait…
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="password">New Password</Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      autoComplete="new-password"
                      required
                      minLength={8}
                      placeholder="Min. 8 characters"
                      className="pr-10"
                    />
                    <PasswordVisibilityToggle
                      visible={showPassword}
                      onToggle={() => setShowPassword(v => !v)}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="confirmPassword">Confirm Password</Label>
                  <div className="relative">
                    <Input
                      id="confirmPassword"
                      type={showConfirm ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={e => setConfirmPassword(e.target.value)}
                      autoComplete="new-password"
                      required
                      placeholder="••••••••"
                      className="pr-10"
                    />
                    <PasswordVisibilityToggle
                      visible={showConfirm}
                      onToggle={() => setShowConfirm(v => !v)}
                    />
                  </div>
                </div>

                {error && (
                  <p className="text-sm text-destructive text-center">{error}</p>
                )}

                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? 'Updating password…' : 'Set new password'}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
