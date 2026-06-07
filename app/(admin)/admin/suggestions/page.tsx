'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * /admin/suggestions — DEPRECATED
 *
 * This route has been consolidated into Sage → Feedback tab to establish
 * a single unified feedback surface. All feedback management now lives at
 * /admin/sage#feedback.
 *
 * This page automatically redirects to maintain backward compatibility
 * with existing bookmarks and links.
 */
export default function AdminSuggestionsRedirectPage() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/admin/sage#feedback')
  }, [router])

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-10 text-center space-y-4">
        <h1 className="text-xl font-semibold text-zinc-100">Feedback has moved</h1>
        <p className="text-sm text-zinc-400">
          User feedback management is now part of <span className="text-amber-400 font-medium">Sage → Feedback</span>.
        </p>
        <p className="text-xs text-zinc-500">
          Redirecting to <a href="/admin/sage#feedback" className="text-amber-400 hover:underline">/admin/sage#feedback</a>...
        </p>
      </div>
    </div>
  )
}
