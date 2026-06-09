'use client'

import { useState, useEffect, useCallback } from 'react'
import { ArrowLeft, KeyRound, Plus, Pencil, Trash2, Loader2, X, Play, Save, Eye, EyeOff, HelpCircle, ExternalLink, AlertTriangle } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'

interface ProviderConfigRow {
  provider:       string
  is_configured:  boolean
  api_key_masked: string | null
  base_url:       string | null
  created_at:     string | null
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai:    'OpenAI',
  google:    'Google',
  mistral:   'Mistral',
  custom:    'Custom',
}

interface ProviderKeyHelp { label: string; url: string; instructions: string }

const PROVIDER_KEY_HELP: Record<string, ProviderKeyHelp> = {
  anthropic: {
    label:        'Get Anthropic API key',
    url:          'https://console.anthropic.com/settings/keys',
    instructions: 'Sign in to Anthropic Console → Settings → API Keys → Create Key',
  },
  openai: {
    label:        'Get OpenAI API key',
    url:          'https://platform.openai.com/api-keys',
    instructions: 'Sign in to OpenAI Platform → API Keys → Create new secret key',
  },
  google: {
    label:        'Get Google AI API key',
    url:          'https://aistudio.google.com/app/apikey',
    instructions: 'Sign in to Google AI Studio → Get API key → Create API key',
  },
  mistral: {
    label:        'Get Mistral API key',
    url:          'https://console.mistral.ai/api-keys/',
    instructions: 'Sign in to Mistral Console → API Keys → Create new key',
  },
  custom: {
    label:        '',
    url:          '',
    instructions: 'Enter the base URL and API key for your custom OpenAI-compatible provider',
  },
}

function ProviderKeyModal({
  provider, hasExisting, hasBaseUrl, onSave, onClose,
}: {
  provider:    string
  hasExisting: boolean
  hasBaseUrl?: string | null
  onSave:      () => void
  onClose:     () => void
}) {
  const [apiKey,     setApiKey]     = useState('')
  const [baseUrl,    setBaseUrl]    = useState(hasBaseUrl ?? '')
  const [showKey,    setShowKey]    = useState(false)
  const [saving,     setSaving]     = useState(false)
  const [testing,    setTesting]    = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; status: number; message: string } | null>(null)
  const [error,      setError]      = useState<string | null>(null)

  const help = PROVIDER_KEY_HELP[provider]

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      if (!apiKey.trim() && !hasExisting) {
        setError('API key is required')
        setSaving(false)
        return
      }
      const body: Record<string, unknown> = { provider }
      if (apiKey.trim()) body.api_key = apiKey.trim()
      if (provider === 'custom' && baseUrl.trim()) body.base_url = baseUrl.trim()

      if (!apiKey.trim() && hasExisting && (provider !== 'custom' || baseUrl === (hasBaseUrl ?? ''))) {
        onClose()
        return
      }
      const res = await fetch('/api/admin/provider-configs', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      const json = await res.json() as { error?: string }
      if (!res.ok) { setError(json.error ?? 'Failed to save'); return }
      onSave()
    } finally { setSaving(false) }
  }

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    try {
      const res  = await fetch(`/api/admin/provider-configs/${provider}/test`, { method: 'POST' })
      const json = await res.json() as { ok: boolean; status: number; message: string }
      setTestResult(json)
    } finally { setTesting(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-md flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-100">{hasExisting ? 'Edit' : 'Add'} {PROVIDER_LABELS[provider]} API Key</h2>
          <button onClick={onClose}><X className="h-5 w-5 text-zinc-400" /></button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {error && (
            <div className="rounded-md border border-red-800 bg-red-950/30 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          {provider === 'custom' && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-300">Base URL</label>
              <input
                type="text"
                value={baseUrl}
                onChange={e => setBaseUrl(e.target.value)}
                placeholder="https://api.custom-provider.com/v1"
                className="w-full h-9 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 font-mono placeholder:text-zinc-600"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <label className="text-xs font-medium text-zinc-300">API Key</label>
              {help?.url && (
                <a
                  href={help.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={help.instructions}
                  className="text-zinc-500 hover:text-blue-400"
                >
                  <HelpCircle className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
            <div className="flex gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={hasExisting ? 'Leave blank to keep existing' : 'sk-...'}
                className="flex-1 h-9 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 font-mono placeholder:text-zinc-600"
              />
              <button
                onClick={() => setShowKey(s => !s)}
                className="h-9 w-9 flex items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 transition-colors"
              >
                {showKey ? <EyeOff className="h-4 w-4 text-zinc-400" /> : <Eye className="h-4 w-4 text-zinc-400" />}
              </button>
            </div>
          </div>

          {help && (
            <div className="rounded-md bg-zinc-800/50 border border-zinc-700 p-3 space-y-1">
              <p className="text-xs text-zinc-400">{help.instructions}</p>
              {help.url && (
                <a
                  href={help.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-400 flex items-center gap-1 hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  {help.label}
                </a>
              )}
            </div>
          )}

          {testResult && (
            <div className={cn(
              'rounded-md border px-3 py-2 text-xs',
              testResult.ok
                ? 'border-green-700 bg-green-950/30 text-green-400'
                : 'border-red-700 bg-red-950/30 text-red-400',
            )}>
              {testResult.ok ? '✓ Connected' : `✗ ${testResult.message}`}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-zinc-800">
          <button
            onClick={() => void handleTest()}
            disabled={testing || (!hasExisting && !apiKey.trim())}
            className="px-3 h-9 text-sm rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
          >
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Test Connection
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 h-9 text-sm rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 transition-colors text-zinc-300"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              className="px-3 h-9 text-sm rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5 text-white"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function AdminProviderDefaultsPage() {
  const router = useRouter()
  const [loading,       setLoading]       = useState(true)
  const [providers,     setProviders]     = useState<ProviderConfigRow[]>([])
  const [editing,       setEditing]       = useState<string | null>(null)
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null)
  const [testingFor,    setTestingFor]    = useState<string | null>(null)
  const [testResults,   setTestResults]   = useState<Record<string, { ok: boolean; message: string }>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await fetch('/api/admin/provider-configs')
      const json = await res.json() as { data?: ProviderConfigRow[]; error?: string }
      if (json.error) {
        console.error('Failed to load provider configs:', json.error)
      }
      setProviders(json.data ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function testProvider(provider: string) {
    setTestingFor(provider)
    try {
      const res = await fetch(`/api/admin/provider-configs/${provider}/test`, { method: 'POST' })
      const json = await res.json() as { ok: boolean; message: string }
      setTestResults(prev => ({ ...prev, [provider]: { ok: json.ok, message: json.message } }))
    } finally {
      setTestingFor(null)
    }
  }

  async function removeProvider(provider: string) {
    await fetch(`/api/admin/provider-configs/${provider}`, { method: 'DELETE' })
    setProviders(prev => prev.map(p => p.provider === provider ? { ...p, is_configured: false, api_key_masked: null } : p))
    setRemoveConfirm(null)
  }

  const editingRow = editing ? providers.find(p => p.provider === editing) : null

  if (loading) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.push('/admin/settings')}
          className="p-2 hover:bg-zinc-800 rounded-md transition-colors"
        >
          <ArrowLeft className="h-5 w-5 text-zinc-400" />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-zinc-100">Provider Defaults</h1>
          <p className="text-xs text-zinc-400 mt-0.5">
            Platform-wide default API keys used as fallback for Sage and Assistant
          </p>
        </div>
      </div>

      {/* Warning banner */}
      <div className="rounded-lg border border-amber-700 bg-amber-950/30 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1 text-sm text-zinc-300 space-y-1">
            <p className="font-medium text-amber-400">Fallback only — not for group agents</p>
            <p className="text-zinc-400">
              These keys are used <strong>only</strong> for admin-level Sage and Assistant when groups haven't configured their own providers.
              Group agents always require explicit per-group provider configuration in Settings → Agents → Provider API Keys.
            </p>
          </div>
        </div>
      </div>

      {/* Provider list */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
        <div className="px-6 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-blue-400" />
            <h2 className="text-sm font-semibold text-zinc-100">Configure Provider API Keys</h2>
          </div>
          <p className="text-xs text-zinc-400 mt-1">
            Add API keys for AI providers that will serve as platform-wide defaults.
          </p>
        </div>
        <div className="divide-y divide-zinc-800">
          {providers.map(p => {
            const result = testResults[p.provider]
            return (
              <div key={p.provider} className="px-6 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-zinc-100">{PROVIDER_LABELS[p.provider]}</span>
                      {p.is_configured ? (
                        <span className="px-1.5 py-0.5 text-[10px] rounded bg-green-950/50 border border-green-800 text-green-400 flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                          Configured
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 text-[10px] rounded border border-zinc-700 text-zinc-500">
                          Not configured
                        </span>
                      )}
                    </div>
                    {p.is_configured && (
                      <>
                        <p className="text-xs text-zinc-500 font-mono mt-0.5">API key: ••••••••••••••••</p>
                        {p.base_url && (
                          <p className="text-xs text-zinc-500 font-mono mt-0.5">Base URL: {p.base_url}</p>
                        )}
                      </>
                    )}
                    {result && (
                      <p className={cn(
                        'text-xs mt-1',
                        result.ok ? 'text-green-400' : 'text-red-400',
                      )}>
                        {result.ok ? '✓ Connected' : `✗ ${result.message}`}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {!p.is_configured ? (
                      <button
                        onClick={() => setEditing(p.provider)}
                        className="h-8 px-3 text-xs rounded-md bg-blue-600 hover:bg-blue-700 transition-colors text-white flex items-center gap-1.5"
                      >
                        <Plus className="h-3.5 w-3.5" /> Add Key
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() => void testProvider(p.provider)}
                          disabled={testingFor === p.provider}
                          className="h-8 px-2 text-xs rounded-md hover:bg-zinc-800 transition-colors text-zinc-300 disabled:opacity-50"
                        >
                          {testingFor === p.provider ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Test'}
                        </button>
                        <button
                          onClick={() => setEditing(p.provider)}
                          title="Edit"
                          className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-zinc-800 transition-colors text-zinc-400"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        {removeConfirm === p.provider ? (
                          <>
                            <button
                              onClick={() => void removeProvider(p.provider)}
                              className="h-8 px-2 text-xs rounded-md bg-red-600 hover:bg-red-700 transition-colors text-white"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setRemoveConfirm(null)}
                              className="h-8 px-2 text-xs rounded-md hover:bg-zinc-800 transition-colors text-zinc-300"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setRemoveConfirm(p.provider)}
                            title="Remove"
                            className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-zinc-800 transition-colors text-red-400"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {editingRow && (
        <ProviderKeyModal
          provider={editingRow.provider}
          hasExisting={editingRow.is_configured}
          hasBaseUrl={editingRow.base_url}
          onSave={() => { setEditing(null); void load() }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
