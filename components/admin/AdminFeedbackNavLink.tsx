'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

/**
 * Top-bar admin nav entry for Sage → Feedback with a live "unread"
 * badge. Polls /api/admin/suggestions every 60 s for the count of rows
 * still in `submitted` status — the same value the page returns alongside
 * its main payload, so the cached query is reused by Next.
 */
export default function AdminFeedbackNavLink() {
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    let cancelled = false
    function load() {
      fetch('/api/admin/suggestions?status=submitted')
        .then(r => r.json())
        .then((j: { unread_count?: number }) => { if (!cancelled) setUnread(j.unread_count ?? 0) })
        .catch(() => {})
    }
    load()
    const id = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  return (
    <Link
      href="/admin/sage#feedback"
      className="px-3 py-1.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors whitespace-nowrap inline-flex items-center gap-1.5"
    >
      Feedback
      {unread > 0 && (
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-500 text-white leading-none">
          {unread}
        </span>
      )}
    </Link>
  )
}
