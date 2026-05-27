'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  Plug, Upload, FileText, Loader2, Check, ExternalLink, Trash2, Lock,
  Briefcase, Mail, Hash, AlertTriangle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input }  from '@/components/ui/input'
import { Label }  from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { cn }     from '@/lib/utils'
import IntegrationsTab from '@/components/settings/IntegrationsTab'

// ─── Types ──────────────────────────────────────────────────────────────────

type Tab = 'financials' | 'marketing' | 'documents' | 'workspace'

interface Company { id: string; name: string; is_active: boolean }
interface Folder  { id: string; name: string; folder_type?: string }
interface FinancialImport {
  id:            string
  company_id:    string | null
  document_id:   string | null
  file_name:     string
  file_path:     string
  data_type:     string
  period:        string | null
  status:        string
  error_message: string | null
  created_at:    string
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const DATA_TYPE_LABELS: Record<string, string> = {
  pl:             'Profit & Loss',
  balance_sheet:  'Balance Sheet',
  cash_flow:      'Cash Flow',
  custom:         'Other',
}

function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  const hrs  = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (hrs  < 24) return `${hrs}h ago`
  if (days < 7)  return `${days}d ago`
  return new Date(iso).toLocaleDateString('en-AU')
}

function statusColor(s: string): string {
  if (s === 'imported')      return 'bg-green-500'
  if (s === 'review_needed') return 'bg-amber-500'
  if (s === 'failed')        return 'bg-red-500'
  if (s === 'processing')    return 'bg-blue-500 animate-pulse'
  return 'bg-muted-foreground/40'
}

// ─── Upload form ────────────────────────────────────────────────────────────

function FinancialUploadForm({
  companies, folders, onUploaded,
}: {
  companies:  Company[]
  folders:    Folder[]
  onUploaded: () => void
}) {
  const [companyId, setCompanyId] = useState('')
  const [dataType,  setDataType]  = useState<'pl' | 'balance_sheet' | 'cash_flow' | 'custom'>('pl')
  const [period,    setPeriod]    = useState('')
  const [folderId,  setFolderId]  = useState('')
  const [file,      setFile]      = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [success,   setSuccess]   = useState(false)

  useEffect(() => {
    if (!folderId && folders.length > 0) {
      const imports = folders.find(f => f.folder_type === 'imports')
      if (imports) setFolderId(imports.id)
    }
  }, [folders, folderId])

  async function handleUpload() {
    if (!file) { setError('Choose a file first'); return }
    setUploading(true)
    setError(null)
    setSuccess(false)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('data_type', dataType)
      if (companyId) fd.append('company_id', companyId)
      if (period)    fd.append('period',     period)
      if (folderId)  fd.append('folder_id',  folderId)

      const res  = await fetch('/api/integrations/financial-imports', { method: 'POST', body: fd })
      const json = await res.json() as { error?: string }
      if (!res.ok) {
        setError(json.error ?? 'Upload failed')
      } else {
        setSuccess(true)
        setFile(null)
        setPeriod('')
        onUploaded()
        setTimeout(() => setSuccess(false), 2500)
      }
    } catch {
      setError('Network error')
    } finally {
      setUploading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Upload Financial Data</CardTitle>
        <CardDescription>
          Import P&amp;L, Balance Sheet, Cash Flow or other financial files. Each upload is stored as a document in the selected folder.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Company</Label>
            <select
              value={companyId}
              onChange={e => setCompanyId(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">— Not company-specific —</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Data Type</Label>
            <select
              value={dataType}
              onChange={e => setDataType(e.target.value as typeof dataType)}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="pl">Profit &amp; Loss</option>
              <option value="balance_sheet">Balance Sheet</option>
              <option value="cash_flow">Cash Flow</option>
              <option value="custom">Other</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Period</Label>
            <Input
              value={period}
              onChange={e => setPeriod(e.target.value)}
              placeholder="e.g. March 2026 or Q1 FY26"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Folder</Label>
            <select
              value={folderId}
              onChange={e => setFolderId(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {folders.map(f => (
                <option key={f.id} value={f.id}>
                  {f.name}{f.folder_type === 'imports' ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>File</Label>
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={e => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-muted-foreground file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-input file:bg-muted file:text-foreground file:text-sm file:cursor-pointer hover:file:bg-muted/80"
          />
          {file && <p className="text-xs text-muted-foreground">{file.name} · {(file.size / 1024).toFixed(0)} KB</p>}
        </div>

        {error   && <p className="text-xs text-destructive">{error}</p>}
        {success && <p className="text-xs text-green-600 flex items-center gap-1"><Check className="h-3 w-3" /> Uploaded</p>}

        <div className="flex justify-end">
          <Button onClick={() => void handleUpload()} disabled={uploading || !file}>
            {uploading
              ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Uploading…</>
              : <><Upload className="h-4 w-4 mr-1.5" /> Upload</>}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Imports history ────────────────────────────────────────────────────────

function ImportsHistory({ imports, companies, onRemoved }: {
  imports:   FinancialImport[]
  companies: Company[]
  onRemoved: () => void
}) {
  const [confirming, setConfirming] = useState<string | null>(null)
  const [removing,   setRemoving]   = useState<string | null>(null)

  async function remove(id: string) {
    setRemoving(id)
    try {
      await fetch(`/api/integrations/financial-imports/${id}`, { method: 'DELETE' })
      onRemoved()
    } finally {
      setRemoving(null)
      setConfirming(null)
    }
  }

  if (imports.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No imports yet. Uploaded files will appear here.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Upload History</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b text-left">
                <th className="px-3 py-2 font-medium text-muted-foreground">File</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Company</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Type</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Period</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Status</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Uploaded</th>
                <th className="px-3 py-2 font-medium text-muted-foreground text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {imports.map(imp => {
                const companyName = companies.find(c => c.id === imp.company_id)?.name ?? '—'
                return (
                  <tr key={imp.id} className="hover:bg-muted/30">
                    <td className="px-3 py-2 truncate max-w-xs">{imp.file_name}</td>
                    <td className="px-3 py-2">{companyName}</td>
                    <td className="px-3 py-2">{DATA_TYPE_LABELS[imp.data_type] ?? imp.data_type}</td>
                    <td className="px-3 py-2">{imp.period ?? '—'}</td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5 text-xs">
                        <span className={cn('h-2 w-2 rounded-full inline-block', statusColor(imp.status))} />
                        <span className="capitalize">{imp.status.replace(/_/g, ' ')}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{relativeDate(imp.created_at)}</td>
                    <td className="px-3 py-2 text-right">
                      {confirming === imp.id ? (
                        <span className="inline-flex items-center gap-1">
                          <Button size="sm" variant="destructive" className="h-7 text-xs px-2"
                            onClick={() => void remove(imp.id)} disabled={removing === imp.id}>
                            {removing === imp.id ? '…' : 'Confirm'}
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 text-xs px-2" onClick={() => setConfirming(null)}>
                            Cancel
                          </Button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          {imp.document_id && (
                            <Link href={`/documents/${imp.document_id}`}
                              className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                              <ExternalLink className="h-3 w-3" /> View
                            </Link>
                          )}
                          <button
                            onClick={() => setConfirming(imp.id)}
                            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive"
                            title="Remove import and underlying document"
                          >
                            <Trash2 className="h-3 w-3" /> Remove
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Coming soon card ───────────────────────────────────────────────────────

function ComingSoonCard({ name, description, emoji }: { name: string; description: string; emoji?: string }) {
  return (
    <Card className="opacity-60">
      <CardContent className="py-4 flex items-center gap-3">
        <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center text-xl shrink-0">
          {emoji ?? '🔌'}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{name}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
          Coming soon
        </span>
      </CardContent>
    </Card>
  )
}

// ─── Sync All to SharePoint ─────────────────────────────────────────────────

function SyncAllSharePointButton() {
  const [working, setWorking] = useState(false)
  const [result,  setResult]  = useState<{ synced: number; failed: number; total: number; errors: string[] } | null>(null)
  const [error,   setError]   = useState<string | null>(null)

  async function run() {
    setWorking(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch('/api/integrations/sharepoint/sync-all', { method: 'POST' })
      const json = await res.json() as {
        synced?: number; failed?: number; total?: number; errors?: string[]; error?: string
      }
      if (!res.ok) {
        setError(json.error ?? 'Sync failed')
      } else {
        setResult({
          synced: json.synced ?? 0,
          failed: json.failed ?? 0,
          total:  json.total  ?? 0,
          errors: json.errors ?? [],
        })
      }
    } catch {
      setError('Network error')
    } finally {
      setWorking(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Bulk sync to SharePoint</CardTitle>
        <CardDescription>
          Pushes every published document to SharePoint, mirroring NavHub folders as subfolders.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button onClick={() => void run()} disabled={working} className="gap-2">
          {working
            ? <><Loader2 className="h-4 w-4 animate-spin" /> Syncing…</>
            : <><Upload className="h-4 w-4" /> Sync All to SharePoint</>}
        </Button>

        {error && <p className="text-xs text-destructive">{error}</p>}
        {result && (
          <div className="text-xs">
            <p className="text-foreground">
              <span className="font-medium text-green-600">{result.synced} synced</span>
              {result.failed > 0 && <span className="text-destructive ml-2">· {result.failed} failed</span>}
              <span className="text-muted-foreground ml-2">· {result.total} total</span>
            </p>
            {result.errors.length > 0 && (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-muted-foreground">View errors ({result.errors.length})</summary>
                <ul className="mt-1 space-y-0.5 text-destructive">
                  {result.errors.map((e, i) => <li key={i} className="font-mono text-[11px]">{e}</li>)}
                </ul>
              </details>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function IntegrationsPage() {
  const [role,         setRole]         = useState<string>('viewer')
  const [visible,      setVisible]      = useState<string[]>([])
  const [loadingRole,  setLoadingRole]  = useState(true)

  const [companies,    setCompanies]    = useState<Company[]>([])
  const [folders,      setFolders]      = useState<Folder[]>([])
  const [imports,      setImports]      = useState<FinancialImport[]>([])

  // Slack workspace state
  const [slackStatus,  setSlackStatus]  = useState<{
    connected:        boolean
    team_name?:       string
    default_channel?: string | null
    configured:       boolean
  }>({ connected: false, configured: false })
  const [slackChannels, setSlackChannels] = useState<{ id: string; name: string; is_member?: boolean }[]>([])
  const [slackWorking,  setSlackWorking]  = useState(false)
  const [slackMsg,      setSlackMsg]      = useState<string | null>(null)
  const [savingChannel, setSavingChannel] = useState(false)

  const [tab, setTab] = useState<Tab>('financials')

  useEffect(() => {
    let finished = 0
    const done = () => { finished++; if (finished === 2) setLoadingRole(false) }

    fetch('/api/user/permissions')
      .then(r => r.json())
      .then((j: { data?: { role: string; matrix: Record<string, Record<string, string>> } }) => {
        if (j.data) {
          setRole(j.data.role)
          const vis = Object.keys(j.data.matrix).filter(f =>
            Object.values(j.data!.matrix[f]).some(v => v === 'view' || v === 'edit'),
          )
          setVisible(vis)
        }
      })
      .catch(() => {})
      .finally(done)

    fetch('/api/groups/active')
      .then(r => r.json())
      .then((j: { data?: { role?: string } }) => { if (j.data?.role) setRole(j.data.role) })
      .catch(() => {})
      .finally(done)
  }, [])

  const loadData = useCallback(async () => {
    const [cRes, fRes, iRes, sRes] = await Promise.all([
      fetch('/api/companies'),
      fetch('/api/documents/folders'),
      fetch('/api/integrations/financial-imports'),
      fetch('/api/integrations/slack/status'),
    ])
    const [cJ, fJ, iJ, sJ] = await Promise.all([cRes.json(), fRes.json(), iRes.json(), sRes.json()])
    setCompanies(((cJ.data ?? []) as Company[]).filter(c => c.is_active))
    setFolders(fJ.data ?? [])
    setImports(iJ.data ?? [])
    const slackData = (sJ as {
      data?: { team_name?: string; default_channel?: string | null } | null
      configured?: boolean
    })
    setSlackStatus({
      connected:       !!slackData.data,
      team_name:       slackData.data?.team_name,
      default_channel: slackData.data?.default_channel ?? null,
      configured:      !!slackData.configured,
    })

    // Load channels when connected
    if (slackData.data) {
      try {
        const chRes  = await fetch('/api/integrations/slack/channels')
        const chJson = await chRes.json() as { channels?: { id: string; name: string; is_member?: boolean }[] }
        setSlackChannels(chJson.channels ?? [])
      } catch { /* ignore */ }
    } else {
      setSlackChannels([])
    }
  }, [])

  useEffect(() => { void loadData() }, [loadData])

  // Listen for Slack popup postMessage
  useEffect(() => {
    function handler(e: MessageEvent) {
      const payload = e.data as { type?: string }
      if (payload?.type === 'slack-connected') {
        setSlackMsg('Slack connected')
        void loadData()
      }
      if (payload?.type === 'slack-error') {
        setSlackMsg('Slack connection failed')
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [loadData])

  function connectSlack() {
    setSlackMsg(null)
    const w = 600, h = 720
    const left = window.screenX + (window.innerWidth  - w) / 2
    const top  = window.screenY + (window.innerHeight - h) / 2
    window.open(
      '/api/integrations/slack/connect',
      'slack-connect',
      `width=${w},height=${h},left=${left},top=${top}`,
    )
  }

  async function disconnectSlack() {
    if (!confirm('Disconnect Slack from this group? Existing agent configs that use Slack will stop sending.')) return
    setSlackWorking(true)
    try {
      await fetch('/api/integrations/slack/status', { method: 'DELETE' })
      await loadData()
      setSlackMsg('Slack disconnected')
    } finally { setSlackWorking(false) }
  }

  async function saveDefaultChannel(channel: string | null) {
    setSavingChannel(true)
    setSlackMsg(null)
    try {
      const res  = await fetch('/api/integrations/slack/status', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ default_channel: channel }),
      })
      if (!res.ok) {
        const json = await res.json() as { error?: string }
        setSlackMsg(json.error ?? 'Failed to save channel')
      } else {
        setSlackStatus(prev => ({ ...prev, default_channel: channel }))
        setSlackMsg('Default channel updated')
      }
    } finally { setSavingChannel(false) }
  }

  const isAdmin        = role === 'super_admin' || role === 'group_owner' || role === 'group_admin'
  const showFinancials = isAdmin || visible.includes('financials')
  const showMarketing  = isAdmin || visible.includes('marketing')
  const showDocuments  = isAdmin || visible.includes('documents') || visible.includes('reports')

  useEffect(() => {
    if (loadingRole) return
    if (tab === 'financials' && !showFinancials) {
      if (showMarketing)      setTab('marketing')
      else if (showDocuments) setTab('documents')
    }
  }, [loadingRole, showFinancials, showMarketing, showDocuments, tab])

  if (loadingRole) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!showFinancials && !showMarketing && !showDocuments) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center max-w-md mx-auto">
        <Lock className="h-10 w-10 text-muted-foreground mb-3" />
        <h2 className="text-lg font-semibold text-foreground">No integration access</h2>
        <p className="text-sm text-muted-foreground mt-1">
          You don&apos;t have permission to view integrations. Contact your group administrator to request access.
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <Plug className="h-5 w-5" /> Integrations
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Connect accounting, marketing, and document services to NavHub.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {showFinancials && (
          <button
            onClick={() => setTab('financials')}
            className={cn(
              'px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2',
              tab === 'financials' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            Financials
          </button>
        )}
        {showMarketing && (
          <button
            onClick={() => setTab('marketing')}
            className={cn(
              'px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2',
              tab === 'marketing' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            Marketing
          </button>
        )}
        {showDocuments && (
          <button
            onClick={() => setTab('documents')}
            className={cn(
              'px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2',
              tab === 'documents' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            Reports &amp; Documents
          </button>
        )}
        {/* Workspace tab — always shown to authenticated group members */}
        <button
          onClick={() => setTab('workspace')}
          className={cn(
            'px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2',
            tab === 'workspace' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          Workspace
        </button>
      </div>

      {/* Financials tab */}
      {tab === 'financials' && showFinancials && (
        <div className="space-y-6">
          <section className="space-y-3">
            <h2 className="text-base font-semibold flex items-center gap-2">
              <Plug className="h-4 w-4 text-primary" /> Accounting Connections
            </h2>
            <IntegrationsTab scope="financials" />
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-muted-foreground">Coming Soon</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <ComingSoonCard name="MYOB"                description="AU small business accounting" emoji="💼" />
              <ComingSoonCard name="QuickBooks Online"   description="Intuit cloud accounting"       emoji="📘" />
              <ComingSoonCard name="ATO Business Portal" description="Tax lodgements + BAS data"    emoji="🏛️" />
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold flex items-center gap-2">
              <Upload className="h-4 w-4 text-primary" /> Data Upload
            </h2>
            <FinancialUploadForm
              companies={companies}
              folders={folders}
              onUploaded={loadData}
            />
            <ImportsHistory imports={imports} companies={companies} onRemoved={loadData} />
          </section>
        </div>
      )}

      {/* Marketing tab */}
      {tab === 'marketing' && showMarketing && (
        <div className="space-y-6">
          <section className="space-y-3">
            <h2 className="text-base font-semibold flex items-center gap-2">
              <span>📊</span> Marketing Platforms
            </h2>
            <p className="text-xs text-muted-foreground">
              Connect marketing platforms to pull data automatically. Manual entry is always available from the{' '}
              <Link href="/marketing" className="text-primary hover:underline">Marketing section</Link>.
            </p>
            <IntegrationsTab scope="marketing" />
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-muted-foreground">Coming Soon</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <ComingSoonCard name="Mailchimp"  description="Email marketing metrics"      emoji="📧" />
              <ComingSoonCard name="HubSpot"    description="CRM + marketing automation"   emoji="🧲" />
              <ComingSoonCard name="Freshsales" description="CRM + sales metrics"          emoji="📈" />
              <ComingSoonCard name="Google Ads" description="Paid search performance"      emoji="🟢" />
            </div>
          </section>
        </div>
      )}

      {/* Reports & Documents tab */}
      {tab === 'documents' && showDocuments && (
        <div className="space-y-6">
          <section className="space-y-3">
            <h2 className="text-base font-semibold flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" /> Document Sync
            </h2>
            <IntegrationsTab scope="documents" />
            {isAdmin && <SyncAllSharePointButton />}
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-muted-foreground">Coming Soon</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <ComingSoonCard name="Google Drive" description="Sync documents to Drive"   emoji="📁" />
              <ComingSoonCard name="Dropbox"      description="Sync documents to Dropbox" emoji="📦" />
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold flex items-center gap-2">
              <Upload className="h-4 w-4 text-primary" /> Document Upload
            </h2>
            <Card>
              <CardContent className="py-6 text-sm text-muted-foreground">
                Upload documents from the{' '}
                <Link href="/documents" className="text-primary hover:underline">Documents</Link>{' '}
                section — drag-and-drop, folder selection, tags and publishing status are all available there.
              </CardContent>
            </Card>
          </section>
        </div>
      )}

      {/* Workspace tab */}
      {tab === 'workspace' && (
        <div className="space-y-6">
          {slackMsg && (
            <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary">
              {slackMsg}
            </div>
          )}

          <section className="space-y-3">
            <h2 className="text-base font-semibold flex items-center gap-2">
              <Mail className="h-4 w-4 text-primary" /> Email Notifications
            </h2>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Sending email</CardTitle>
                <CardDescription>
                  NavHub sends notifications via Resend using the configured app-level
                  <code className="mx-1 px-1 rounded bg-muted text-foreground font-mono text-xs">RESEND_FROM_DOMAIN</code>.
                  Each agent configures its own recipient list on the Notifications tab.
                </CardDescription>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                No group-level configuration required.
              </CardContent>
            </Card>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold flex items-center gap-2">
              <Hash className="h-4 w-4 text-primary" /> Slack
            </h2>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Slack workspace</CardTitle>
                <CardDescription>
                  Connect your Slack workspace so agents can post notifications to channels.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {!slackStatus.configured && (
                  <div className="rounded-md border border-amber-300/50 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                    Slack OAuth not configured — set <code className="font-mono">SLACK_CLIENT_ID</code> and <code className="font-mono">SLACK_CLIENT_SECRET</code> in env.
                  </div>
                )}

                {slackStatus.connected ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
                      <div>
                        <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
                          <Check className="h-3.5 w-3.5 text-green-600" />
                          Connected to <span>{slackStatus.team_name ?? 'Slack workspace'}</span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Agents can send notifications to any channel the bot is a member of.
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm" variant="outline"
                          onClick={connectSlack}
                          disabled={!slackStatus.configured}
                          title="Reauthorise the workspace (e.g. to grant new scopes)"
                        >
                          Reconnect
                        </Button>
                        <Button
                          size="sm" variant="outline"
                          onClick={() => void disconnectSlack()}
                          disabled={slackWorking}
                        >
                          Disconnect
                        </Button>
                      </div>
                    </div>

                    {/* Default channel picker */}
                    <div className="rounded-md border bg-muted/10 px-3 py-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label className="text-xs">Default channel</Label>
                        {savingChannel && <span className="text-[11px] text-muted-foreground">Saving…</span>}
                      </div>
                      {slackChannels.length > 0 ? (
                        <select
                          value={slackStatus.default_channel ?? ''}
                          onChange={e => void saveDefaultChannel(e.target.value || null)}
                          disabled={savingChannel}
                          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                        >
                          <option value="">— No default —</option>
                          {slackChannels.map(c => (
                            <option key={c.id} value={`#${c.name}`}>#{c.name}{c.is_member ? '' : ' (bot not in channel)'}</option>
                          ))}
                        </select>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          Couldn&apos;t load channels. Try Reconnect to grant the bot the
                          <code className="font-mono mx-1">channels:read</code> scope.
                        </p>
                      )}
                      <p className="text-[11px] text-muted-foreground">
                        Agents fall back to this channel when their own override is empty.
                      </p>
                    </div>

                    {/* Bot setup instructions — must be invited to each channel */}
                    <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950 dark:border-amber-800 px-3 py-3 space-y-2">
                      <div className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-200">
                        <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                        NavHub bot must be added to each channel
                      </div>
                      <p className="text-xs text-amber-700 dark:text-amber-300">
                        Before NavHub can post to a channel, you must invite the bot. In Slack, open the channel and type:
                      </p>
                      <div className="rounded bg-amber-100 dark:bg-amber-900 px-3 py-2 font-mono text-xs text-amber-900 dark:text-amber-100 select-all">
                        /invite @NavHub
                      </div>
                      <p className="text-[11px] text-amber-700 dark:text-amber-300">
                        Do this for every channel you want to use for agent notifications. Channels marked
                        &quot;(bot not in channel)&quot; in the picker above won&apos;t receive messages until the
                        bot is added.
                      </p>
                    </div>
                  </div>
                ) : (
                  <Button
                    onClick={connectSlack}
                    disabled={!slackStatus.configured}
                    className="gap-2"
                  >
                    <Briefcase className="h-4 w-4" />
                    Connect Slack
                  </Button>
                )}
              </CardContent>
            </Card>
          </section>
        </div>
      )}
    </div>
  )
}
