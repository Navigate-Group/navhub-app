'use client'

import { createContext, useCallback, useContext, useRef, useState } from 'react'
import { CheckCircle2, XCircle, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Minimal, dependency-free toast system for the Markets curation surface
 * (MKT-6). Success / error toasts stack top-right, auto-dismiss, and are
 * theme-aware (light / dark) via the shared design tokens. Accessible: the
 * live region is polite for success and assertive for errors.
 */
type ToastKind = 'success' | 'error'
interface Toast {
  id: number
  kind: ToastKind
  message: string
}

interface ToastApi {
  success: (message: string) => void
  error: (message: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>')
  return ctx
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const remove = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = nextId.current++
    setToasts(prev => [...prev, { id, kind, message }])
    window.setTimeout(() => remove(id), kind === 'error' ? 6000 : 4000)
  }, [remove])

  const api: ToastApi = {
    success: m => push('success', m),
    error: m => push('error', m),
  }

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed right-3 top-16 z-[60] flex w-[min(92vw,20rem)] flex-col gap-2"
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map(t => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className={cn(
              'pointer-events-auto flex items-start gap-2 rounded-lg border p-3 text-sm shadow-lg',
              'bg-card text-card-foreground',
              t.kind === 'error' ? 'border-destructive/50' : 'border-emerald-500/40',
            )}
          >
            {t.kind === 'error'
              ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />}
            <span className="flex-1 break-words">{t.message}</span>
            <button
              type="button"
              onClick={() => remove(t.id)}
              className="shrink-0 rounded text-muted-foreground hover:text-foreground"
              aria-label="Dismiss notification"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
