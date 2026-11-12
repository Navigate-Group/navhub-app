'use client'

import ManageTabs from './ManageTabs'
import { ToastProvider } from './Toaster'

/**
 * Client shell for a Markets curation sub-page (MKT-6). Wraps the manager UI in
 * the toast provider and renders the manage tab navigation + a page header. The
 * server page gates access (manager+) before rendering this.
 */
export default function ManagePage({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <ToastProvider>
      <div className="mx-auto max-w-6xl space-y-4">
        <ManageTabs />
        <div>
          <h1 className="text-2xl font-bold">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {children}
      </div>
    </ToastProvider>
  )
}
