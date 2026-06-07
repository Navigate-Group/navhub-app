'use client'

import { useState, useEffect } from 'react'
import { ArrowLeft, Copy, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import Link from 'next/link'

interface SageSettings {
  id?: string
  builder_url: string
  shared_secret: string
  app_slug: string
}

export default function SageSettingsPage() {
  const [settings, setSettings] = useState<SageSettings>({
    builder_url: '',
    shared_secret: '',
    app_slug: '',
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    loadSettings()
  }, [])

  async function loadSettings() {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/sage/settings')
      if (res.ok) {
        const data = await res.json()
        if (data.settings) {
          setSettings(data.settings)
        }
      }
    } catch (err) {
      console.error('Failed to load settings:', err)
    } finally {
      setLoading(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch('/api/admin/sage/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      const data = await res.json()
      if (!res.ok) {
        const errorMsg = data.details ? `${data.error}: ${data.details}` : (data.error ?? 'Save failed')
        throw new Error(errorMsg)
      }

      setToast({ type: 'success', message: 'Settings saved successfully' })
      setSettings(data.settings)
    } catch (err) {
      setToast({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to save settings'
      })
    } finally {
      setSaving(false)
    }
  }

  async function handleTestConnection() {
    setTesting(true)
    try {
      const res = await fetch('/api/sage/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      const data = await res.json()
      if (!res.ok) {
        const errorMsg = data.details ? `${data.error}: ${data.details}` : (data.error ?? 'Connection test failed')
        throw new Error(errorMsg)
      }

      setToast({ type: 'success', message: data.message ?? 'Connection successful' })
    } catch (err) {
      setToast({
        type: 'error',
        message: err instanceof Error ? err.message : 'Connection test failed'
      })
    } finally {
      setTesting(false)
    }
  }

  async function copyToClipboard(text: string, field: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(field)
      setTimeout(() => setCopied(null), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  const isComplete = settings.builder_url && settings.shared_secret && settings.app_slug

  if (loading) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-6 w-6 text-zinc-400 animate-spin" />
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/admin/settings"
          className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-zinc-100">Sage Connection Settings</h1>
          <p className="text-xs text-zinc-400 mt-0.5">
            Configure connection to Builder&apos;s Kaizen contract endpoint
          </p>
        </div>
      </div>

      {/* Settings Form */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 space-y-5">
        {/* Builder URL */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-zinc-200">
            Builder URL
          </label>
          <p className="text-xs text-zinc-500">
            The base URL of your Builder instance (e.g., https://builder.yourcompany.com)
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={settings.builder_url}
              onChange={(e) => setSettings({ ...settings, builder_url: e.target.value })}
              placeholder="https://builder.example.com"
              className="flex-1 h-9 px-3 rounded border border-zinc-700 bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/50"
            />
            <button
              onClick={() => copyToClipboard(settings.builder_url, 'builder_url')}
              className="p-2 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              title="Copy to clipboard"
            >
              {copied === 'builder_url' ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>

        {/* Shared Secret */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-zinc-200">
            Shared Secret
          </label>
          <p className="text-xs text-zinc-500">
            HMAC-SHA256 signing key for contract authentication. Must match Builder&apos;s config.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={settings.shared_secret}
              onChange={(e) => setSettings({ ...settings, shared_secret: e.target.value })}
              placeholder="Enter shared secret"
              className="flex-1 h-9 px-3 rounded border border-zinc-700 bg-zinc-950 text-zinc-100 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-500/50"
            />
            <button
              onClick={() => copyToClipboard(settings.shared_secret, 'shared_secret')}
              className="p-2 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              title="Copy to clipboard"
            >
              {copied === 'shared_secret' ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>

        {/* App Slug */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-zinc-200">
            App Slug
          </label>
          <p className="text-xs text-zinc-500">
            Unique identifier for this Kaizen app instance in Builder&apos;s registry
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={settings.app_slug}
              onChange={(e) => setSettings({ ...settings, app_slug: e.target.value })}
              placeholder="my-app-prod"
              className="flex-1 h-9 px-3 rounded border border-zinc-700 bg-zinc-950 text-zinc-100 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-500/50"
            />
            <button
              onClick={() => copyToClipboard(settings.app_slug, 'app_slug')}
              className="p-2 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              title="Copy to clipboard"
            >
              {copied === 'app_slug' ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 pt-4 border-t border-zinc-800">
          <button
            onClick={handleSave}
            disabled={saving || !isComplete}
            className="px-4 py-2 rounded bg-violet-500 text-zinc-950 font-semibold text-sm hover:bg-violet-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving...
              </span>
            ) : (
              'Save Settings'
            )}
          </button>

          <button
            onClick={handleTestConnection}
            disabled={testing || !isComplete}
            className="px-4 py-2 rounded border border-zinc-700 text-zinc-200 font-medium text-sm hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {testing ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Testing...
              </span>
            ) : (
              'Test Connection'
            )}
          </button>
        </div>

        {/* Info box */}
        {!isComplete && (
          <div className="flex items-start gap-2 p-3 rounded bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <p>All fields are required to save settings and test the connection.</p>
          </div>
        )}
      </div>

      {/* Environment variable fallback notice */}
      {!settings.id && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/20 p-4">
          <p className="text-xs text-zinc-400">
            <span className="font-semibold text-zinc-300">Note:</span> No database settings found.
            Connection will fall back to environment variables (BUILDER_URL, SAGE_SHARED_SECRET, SAGE_APP_SLUG)
            until you save settings here.
          </p>
        </div>
      )}

      {/* Toast notification */}
      {toast && (
        <div className="fixed bottom-4 right-4 z-50">
          <div className={`flex items-start gap-3 px-4 py-3 rounded-lg border shadow-lg ${
            toast.type === 'success'
              ? 'bg-emerald-900/90 border-emerald-700 text-emerald-100'
              : 'bg-red-900/90 border-red-700 text-red-100'
          }`}>
            {toast.type === 'success' ? (
              <CheckCircle2 className="h-5 w-5 shrink-0" />
            ) : (
              <AlertCircle className="h-5 w-5 shrink-0" />
            )}
            <div className="text-sm">{toast.message}</div>
          </div>
        </div>
      )}
    </div>
  )
}
