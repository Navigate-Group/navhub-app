import Link from 'next/link'
import { Settings, Link2 } from 'lucide-react'

export default function AdminSettingsPage() {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Settings</h1>
        <p className="text-xs text-zinc-400 mt-0.5">
          Platform configuration and integrations
        </p>
      </div>

      {/* Settings categories */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Sage Connection Settings */}
        <Link
          href="/admin/settings/sage"
          className="block p-6 rounded-lg border border-zinc-800 bg-zinc-900/40 hover:bg-zinc-900/60 transition-colors"
        >
          <div className="flex items-start gap-3">
            <div className="p-2 rounded bg-violet-500/10 border border-violet-500/20">
              <Link2 className="h-5 w-5 text-violet-400" />
            </div>
            <div className="flex-1">
              <h2 className="text-sm font-semibold text-zinc-100">Sage Connection</h2>
              <p className="text-xs text-zinc-400 mt-1">
                Configure connection to Builder&apos;s Kaizen (contract URL, shared secret, app slug)
              </p>
            </div>
          </div>
        </Link>

        {/* Placeholder for future settings categories */}
        <div className="p-6 rounded-lg border border-dashed border-zinc-800 bg-zinc-900/20">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded bg-zinc-800">
              <Settings className="h-5 w-5 text-zinc-600" />
            </div>
            <div className="flex-1">
              <h2 className="text-sm font-semibold text-zinc-400">More settings coming soon</h2>
              <p className="text-xs text-zinc-500 mt-1">
                Additional platform configuration options will appear here
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
