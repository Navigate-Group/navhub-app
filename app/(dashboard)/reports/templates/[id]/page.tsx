'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ChevronLeft, FileText, Clock, Check, X, Pencil, RotateCcw, Loader2,
  BarChart2, Grid2X2, FileEdit, LayoutDashboard, Workflow, FlaskConical,
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { ReportTemplate, ReportTemplateVersion, TemplateType, SlotDataSource, Agent } from '@/lib/types'
import { V5_TEST_PROMPT } from '@/lib/agent-prompts/v5-test-run'

// ─── Config ───────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<TemplateType, string> = {
  financial: 'Financial', matrix: 'Matrix', narrative: 'Narrative',
  dashboard: 'Dashboard', workflow: 'Workflow',
}
const TYPE_ICONS: Record<TemplateType, React.ComponentType<{ className?: string }>> = {
  financial: BarChart2, matrix: Grid2X2, narrative: FileEdit,
  dashboard: LayoutDashboard, workflow: Workflow,
}

const SOURCE_LABELS: Record<SlotDataSource, string> = {
  navhub_financial: 'NavHub Financial',
  manual:           'Manual',
  uploaded_file:    'Uploaded File',
  agent_provided:   'Agent Provided',
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

type TabKey = 'overview' | 'slots' | 'tokens' | 'versions'

// ─── V5 Test Modal ────────────────────────────────────────────────────────────

function V5TestModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [agents,    setAgents]    = useState<Agent[]>([])
  const [agentId,   setAgentId]   = useState('')
  const [period,    setPeriod]    = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })
  const [launching, setLaunching] = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/agents')
      .then(r => r.json())
      .then(json => {
        const list = (json.data ?? []) as Agent[]
        const active = list.filter(a => a.is_active)
        setAgents(active)
        if (active.length > 0) setAgentId(active[0].id)
      })
      .catch(() => {})
  }, [])

  async function handleLaunch() {
    if (!agentId) { setError('Select an agent to run with'); return }
    setLaunching(true)
    setError(null)
    try {
      const res  = await fetch(`/api/agents/${agentId}/run`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ period, extra_instructions: V5_TEST_PROMPT }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to start run')
      onClose()
      router.push(`/agents/runs/${json.data.run_id as string}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start run')
      setLaunching(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-background border rounded-xl shadow-2xl w-full max-w-2xl mx-4 flex flex-col max-h-[90vh]">
        <div className="p-6 space-y-4 flex flex-col flex-1 min-h-0">
          {/* Header */}
          <div className="flex items-start justify-between gap-3 shrink-0">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <FlaskConical className="h-5 w-5 text-primary" />
                Run V5 Test
              </h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                Launch an end-to-end agent test using AxisTech Group data.
              </p>
            </div>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground shrink-0 mt-0.5">
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Prompt preview */}
          <div className="flex-1 min-h-0 space-y-1.5 overflow-hidden flex flex-col">
            <label className="text-sm font-medium text-foreground shrink-0">Agent Prompt (read-only)</label>
            <textarea
              readOnly
              value={V5_TEST_PROMPT}
              className="flex-1 min-h-0 rounded-md border bg-muted/40 px-3 py-2 text-xs font-mono text-muted-foreground resize-none focus:outline-none overflow-y-auto"
            />
          </div>

          {/* Config row */}
          <div className="grid grid-cols-2 gap-4 shrink-0">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Agent</label>
              <select
                value={agentId}
                onChange={e => setAgentId(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {agents.length === 0 && <option value="">No active agents found</option>}
                {agents.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Period</label>
              <input
                type="month"
                value={period}
                onChange={e => setPeriod(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
          </div>

          {error && <p className="text-sm text-destructive shrink-0">{error}</p>}

          {/* Actions */}
          <div className="flex gap-2 justify-end shrink-0">
            <button
              onClick={onClose}
              disabled={launching}
              className="px-4 py-2 rounded-md border text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleLaunch()}
              disabled={launching || !agentId}
              className="flex items-center gap-2 px-5 py-2 rounded-md text-sm font-medium text-white disabled:opacity-50"
              style={{ backgroundColor: 'var(--palette-primary)' }}
            >
              {launching
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Launching…</>
                : <><FlaskConical className="h-4 w-4" /> Launch Agent Run</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TemplateDetailPage() {
  const params     = useParams()
  const router     = useRouter()
  const templateId = params?.id as string

  const [template,     setTemplate]     = useState<ReportTemplate | null>(null)
  const [versions,     setVersions]     = useState<ReportTemplateVersion[]>([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState<string | null>(null)
  const [isAdmin,      setIsAdmin]      = useState(false)
  const [isSuperAdmin, setIsSuperAdmin] = useState(false)
  const [tab,          setTab]          = useState<TabKey>('overview')
  const [deleting,     setDeleting]     = useState(false)
  const [restoring,    setRestoring]    = useState<string | null>(null)
  const [showV5Modal,  setShowV5Modal]  = useState(false)

  const load = useCallback(async () => {
    try {
      const [tmplRes, groupRes] = await Promise.all([
        fetch(`/api/report-templates/${templateId}`),
        fetch('/api/groups/active'),
      ])
      const [tmplJson, groupJson] = await Promise.all([tmplRes.json(), groupRes.json()])
      if (!tmplRes.ok) throw new Error(tmplJson.error ?? 'Not found')
      setTemplate(tmplJson.data)
      const role = groupJson.data?.role
      setIsAdmin(role === 'super_admin' || role === 'group_owner' || role === 'group_admin')
      setIsSuperAdmin(role === 'super_admin')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally {
      setLoading(false)
    }
  }, [templateId])

  const loadVersions = useCallback(async () => {
    try {
      const res  = await fetch(`/api/report-templates/${templateId}/versions`)
      const json = await res.json()
      setVersions(json.data ?? [])
    } catch { /* ignore */ }
  }, [templateId])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (tab === 'versions') loadVersions()
  }, [tab, loadVersions])

  async function handleDelete() {
    if (!confirm(`Delete template "${template?.name}"? This action cannot be undone.`)) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/report-templates/${templateId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      router.push('/reports/templates')
    } catch {
      setDeleting(false)
    }
  }

  async function handleRestore(versionId: string) {
    if (!confirm('Restore this version? The current template will be saved as a version first.')) return
    setRestoring(versionId)
    try {
      const res  = await fetch(`/api/report-templates/${templateId}/versions/${versionId}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to fetch version')
      const v = json.data

      const patchRes = await fetch(`/api/report-templates/${templateId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          design_tokens: v.design_tokens,
          slots:         v.slots,
          scaffold_html: v.scaffold_html,
          scaffold_css:  v.scaffold_css,
          scaffold_js:   v.scaffold_js,
        }),
      })
      if (!patchRes.ok) throw new Error('Restore failed')
      await load()
      setTab('overview')
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Restore failed')
    } finally {
      setRestoring(null)
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-32 bg-muted animate-pulse rounded-lg" />
      </div>
    )
  }

  if (error || !template) {
    return (
      <div className="space-y-4">
        <Link href="/reports/templates" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" /> Back to templates
        </Link>
        <p className="text-sm text-destructive">{error ?? 'Template not found'}</p>
      </div>
    )
  }

  const Icon        = TYPE_ICONS[template.template_type]
  const isV5Matrix  = template.name === 'Role & Task Matrix'

  const TABS: Array<{ key: TabKey; label: string }> = [
    { key: 'overview', label: 'Overview'       },
    { key: 'slots',    label: `Slots (${template.slots.length})` },
    { key: 'tokens',   label: `Design Tokens (${Object.keys(template.design_tokens).length})` },
    { key: 'versions', label: 'Version History' },
  ]

  return (
    <div className="space-y-6 max-w-4xl">
      {/* V5 Test Modal */}
      {showV5Modal && <V5TestModal onClose={() => setShowV5Modal(false)} />}

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Link href="/reports/templates" className="text-muted-foreground hover:text-foreground">
            <ChevronLeft className="h-5 w-5" />
          </Link>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-foreground">{template.name}</h1>
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-semibold bg-muted text-muted-foreground">
                <Icon className="h-3 w-3" />
                {TYPE_LABELS[template.template_type]}
              </span>
              <Badge variant="outline" className="text-xs">v{template.version}</Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Updated {formatDate(template.updated_at)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Run V5 Test — super_admin only, V5 Matrix template only */}
          {isSuperAdmin && isV5Matrix && (
            <button
              onClick={() => setShowV5Modal(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-md border border-dashed text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <FlaskConical className="h-4 w-4" />
              Run V5 Test
            </button>
          )}

          <Link
            href={`/reports/templates/${templateId}/generate`}
            className="flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium text-white"
            style={{ backgroundColor: 'var(--palette-primary)' }}
          >
            <FileText className="h-4 w-4" />
            Generate Report
          </Link>
          {isAdmin && (
            <>
              <Link
                href={`/reports/templates/${templateId}/edit`}
                className="flex items-center gap-1.5 px-3 py-2 rounded-md border text-sm text-foreground hover:bg-muted transition-colors"
              >
                <Pencil className="h-4 w-4" />
                Edit
              </Link>
              <button
                onClick={() => void handleDelete()}
                disabled={deleting}
                className="flex items-center gap-1.5 px-3 py-2 rounded-md border text-sm text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
              >
                <X className="h-4 w-4" />
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-0 border-b">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px',
              tab === t.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Overview tab ── */}
      {tab === 'overview' && (
        <div className="space-y-4">
          {template.description && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Description</CardTitle></CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{template.description}</p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle className="text-sm">Metadata</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Type</span>
                <span className="text-foreground">{TYPE_LABELS[template.template_type]}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Version</span>
                <span className="text-foreground">{template.version}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Created</span>
                <span className="text-foreground">{formatDate(template.created_at)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Scaffold HTML</span>
                <span className="text-foreground">{template.scaffold_html ? '✓ Present' : '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Scaffold CSS</span>
                <span className="text-foreground">{template.scaffold_css ? '✓ Present' : '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Scaffold JS</span>
                <span className="text-foreground">{template.scaffold_js ? '✓ Present' : '—'}</span>
              </div>
            </CardContent>
          </Card>

          {template.agent_instructions && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Agent Instructions</CardTitle>
                <CardDescription>Instructions for AI agents generating content for this template.</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono bg-muted/40 p-3 rounded-md">
                  {template.agent_instructions}
                </pre>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── Slots tab ── */}
      {tab === 'slots' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Slot Definitions</CardTitle>
            <CardDescription>Placeholders in this template that receive data when a report is generated.</CardDescription>
          </CardHeader>
          <CardContent>
            {template.slots.length === 0 ? (
              <p className="text-sm text-muted-foreground">No slots defined.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-muted-foreground text-xs">
                      <th className="text-left py-2 pr-4 font-medium">Name</th>
                      <th className="text-left py-2 pr-4 font-medium">Label</th>
                      <th className="text-left py-2 pr-4 font-medium">Type</th>
                      <th className="text-left py-2 pr-4 font-medium">Required</th>
                      <th className="text-left py-2 pr-4 font-medium">Source</th>
                      <th className="text-left py-2 font-medium">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {template.slots.map((slot, i) => (
                      <tr key={i} className="border-b border-border/40 last:border-0">
                        <td className="py-2 pr-4 font-mono text-xs text-foreground">{slot.name}</td>
                        <td className="py-2 pr-4 text-foreground">{slot.label}</td>
                        <td className="py-2 pr-4">
                          <Badge variant="outline" className="text-xs">{slot.type}</Badge>
                        </td>
                        <td className="py-2 pr-4">
                          {slot.required
                            ? <Check className="h-3.5 w-3.5 text-green-600" />
                            : <X className="h-3.5 w-3.5 text-muted-foreground" />}
                        </td>
                        <td className="py-2 pr-4 text-xs text-muted-foreground">{SOURCE_LABELS[slot.data_source]}</td>
                        <td className="py-2 text-xs text-muted-foreground">{slot.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Design Tokens tab ── */}
      {tab === 'tokens' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Design Tokens</CardTitle>
            <CardDescription>CSS values injected into the template stylesheet via {'{{token_name}}'} placeholders.</CardDescription>
          </CardHeader>
          <CardContent>
            {Object.keys(template.design_tokens).length === 0 ? (
              <p className="text-sm text-muted-foreground">No design tokens defined.</p>
            ) : (
              <div className="space-y-2">
                {Object.entries(template.design_tokens).map(([key, value]) => {
                  const isColor = /^#[0-9a-fA-F]{3,8}$|^rgb|^hsl/.test(value)
                  return (
                    <div key={key} className="flex items-center gap-3 py-1.5 border-b border-border/30 last:border-0">
                      {isColor && (
                        <span
                          className="w-5 h-5 rounded border border-border/50 shrink-0"
                          style={{ backgroundColor: value }}
                        />
                      )}
                      <code className="text-xs font-mono text-muted-foreground flex-1">{`{{${key}}}`}</code>
                      <code className="text-xs font-mono text-foreground">{value}</code>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Versions tab ── */}
      {tab === 'versions' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Version History</CardTitle>
            <CardDescription>Automatically saved when the template is updated.</CardDescription>
          </CardHeader>
          <CardContent>
            {versions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No previous versions recorded.</p>
            ) : (
              <div className="space-y-2">
                {versions.map(v => (
                  <div key={v.id} className="flex items-center justify-between py-2 border-b border-border/40 last:border-0">
                    <div className="flex items-center gap-3">
                      <Badge variant="outline" className="text-xs">v{v.version}</Badge>
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatDate(v.created_at)}
                      </span>
                    </div>
                    {isAdmin && (
                      <button
                        onClick={() => void handleRestore(v.id)}
                        disabled={restoring === v.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition-colors"
                      >
                        {restoring === v.id
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : <RotateCcw className="h-3 w-3" />}
                        Restore
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
