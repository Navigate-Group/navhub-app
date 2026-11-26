'use client'

import { Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── PasswordVisibilityToggle ─────────────────────────────────────────────────
// A reusable eye / eye-off button that flips a password field between hidden
// and visible. Place it inside a `relative` wrapper around the input; it pins
// itself to the right edge. The consuming field owns the visible/hidden state
// so it can swap the input's `type` between 'password' and 'text'.
//
// type="button" keeps it from submitting the surrounding form, and the
// aria-label flips so screen-reader users know what the control does.

export interface PasswordVisibilityToggleProps {
  visible: boolean
  onToggle: () => void
  className?: string
}

export function PasswordVisibilityToggle({
  visible,
  onToggle,
  className,
}: PasswordVisibilityToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      tabIndex={-1}
      aria-label={visible ? 'Hide password' : 'Show password'}
      aria-pressed={visible}
      className={cn(
        'absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground hover:text-foreground transition-colors focus:outline-none focus-visible:text-foreground',
        className
      )}
    >
      {visible
        ? <EyeOff className="h-4 w-4" aria-hidden="true" />
        : <Eye className="h-4 w-4" aria-hidden="true" />}
    </button>
  )
}
