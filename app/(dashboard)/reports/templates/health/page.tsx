'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface TemplateHealth {
  id:               string
  name:             string
  template_type:    string
  version:          number
  slot_count:       number
  token_count:      number
  scaffold_html:    boolean
  scaffold_css:     boolean
  scaffold_js:      boolean
  reports_generated: number
  updated_at:       string
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function typeLabel(t: string) {
  const map: Record<string, string> = {
    financial: 'Financial',
    matrix:    'Matrix',
    narrative: 'Narrative',
    dashboard: 'Dashboard',
    workflow:  'Workflow',
  }
  return map[t] ?? t
}

function typeBadgeClass(t: string) {
  const map: Record<string, string> = {
    financial: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
    matrix:    'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300',
    narrative: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300',
    dashboard: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300',
    workflow:  'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300',
  }
  return `inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${map[t] ?? 'bg-muted text-muted-foreground'}`
}

function ScaffoldDot({ present }: { present: boolean }) {
  return present
    ? <CheckCircle2 className="h-4 w-4 text-green-500" />
    : <XCircle className="h-4 w-4 text-red-400 dark:text-red-500" />
}

function healthScore(t: TemplateHealth): 'good' | 'warn' | 'bad' {
  const hasAllScaffold = t.scaffold_html && t.scaffold_css
  if (!hasAllScaffold) return 'bad'
  if (t.slot_count === 0) return 'warn'
  return 'good'
}

function HealthBadge({ score }: { score: 'good' | 'warn' | 'bad' }) {
  if (score === 'good') return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300">
      <CheckCircle2 className="h-3 w-3" /> OK
    </span>
  )
  if (score === 'warn') return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
      <AlertTriangle className="h-3 w-3" /> No slots
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300">
      <XCircle className="h-3 w-3" /> Missing scaffold
    </span>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────────
 
export default function TemplateHealthPage() {
  const [templates, setTemplates] = useState<TemplateHealth[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      try {
        // Check admin role
        const roleRes = await fetch('/api/groups/active')
        if (roleRes.ok) {
          const roleJson = await roleRes.json()
          const role = roleJson.data?.role as string | undefined
          if (role !== 'super_admin' && role !== 'group_owner' && role !== 'group_admin') {
            setError('Admin access required.')
            setLoading(false)
            return
          }
        }

        // Fetch templates (list — no scaffold content)
        const [tplRes, rptRes] = await Promise.all([
          fetch('/api/report-templates'),
          fetch('/api/reports/custom'),
        ])
        const tplJson = await tplRes.json()
        const rptJson = await rptRes.json()

        const rawTemplates = (tplJson.data ?? []) as {
          id: string
          name: string
          template_type: string
          version: number
          slots: unknown[]
          design_tokens: Record<string, string>
          updated_at: string
          // scaffold presence returned by detail route only — use fallback
        }[]

        const reports = (rptJson.data ?? []) as { template_id?: string | null }[]

        // Count generated reports per template
        const reportCount: Record<string, number> = {}
        for (const r of reports) {
          if (r.template_id) {
            reportCount[r.template_id] = (reportCount[r.template_id] ?? 0) + 1
          }
        }

        // Fetch each template's full record to check scaffold presence
        const detailed = await Promise.all(
          rawTemplates.map(async tpl => {
            const res = await fetch(`/api/report-templates/${tpl.id}`)
            const json = await res.json()
            const d = json.data as {
              scaffold_html?: string | null
              scaffold_css?: string | null
              scaffold_js?: string | null
            } | undefined
            return {
              id:               tpl.id,
              name:             tpl.name,
              template_type:    tpl.template_type,
              version:          tpl.version,
              slot_count:       (tpl.slots ?? []).length,
              token_count:      Object.keys(tpl.design_tokens ?? {}).length,
              scaffold_html:    !!d?.scaffold_html,
              scaffold_css:     !!d?.scaffold_css,
              scaffold_js:      !!d?.scaffold_js,
              reports_generated: reportCount[tpl.id] ?? 0,
              updated_at:       tpl.updated_at,
            } satisfies TemplateHealth
          })
        )

        setTemplates(detailed)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load')
      } finally {
        setLoading(false)
      }
    }
    void load()
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh] text-muted-foreground text-sm">
        Loading health data…
      </div>
    )
  }

  if (error) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12">
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-sm text-destructive">
          {error}
        </div>
      </div>
    )
  }

  const goodCount = templates.filter(t => healthScore(t) === 'good').length
  const warnCount = templates.filter(t => healthScore(t) === 'warn').length
  const badCount  = templates.filter(t => healthScore(t) === 'bad').length

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link href="/reports/templates">
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
              <ArrowLeft className="h-4 w-4" /> Templates
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">Template System Health</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {templates.length} template{templates.length !== 1 ? 's' : ''} · {' '}
              <span className="text-green-600 dark:text-green-400">{goodCount} OK</span>
              {warnCount > 0 && <> · <span className="text-amber-600 dark:text-amber-400">{warnCount} warnings</span></>}
              {badCount > 0  && <> · <span className="text-red-600 dark:text-red-400">{badCount} errors</span></>}
            </p>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border p-4 space-y-1">
          <p className="text-xs text-muted-foreground">Total templates</p>
          <p className="text-2xl font-bold">{templates.length}</p>
        </div>
        <div className="rounded-lg border p-4 space-y-1">
          <p className="text-xs text-muted-foreground">Reports generated</p>
          <p className="text-2xl font-bold">
            {templates.reduce((s, t) => s + t.reports_generated, 0)}
          </p>
        </div>
        <div className="rounded-lg border p-4 space-y-1">
          <p className="text-xs text-muted-foreground">Total slots defined</p>
          <p className="text-2xl font-bold">
            {templates.reduce((s, t) => s + t.slot_count, 0)}
          </p>
        </div>
      </div>

      {/* Table */}
      {templates.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-muted-foreground text-sm">No active templates found.</p>
          <Link href="/reports/templates/new">
            <Button className="mt-4" size="sm">Create your first template</Button>
          </Link>
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Template</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Type</th>
                <th className="text-center px-3 py-3 font-medium text-muted-foreground">v</th>
                <th className="text-center px-3 py-3 font-medium text-muted-foreground">Slots</th>
                <th className="text-center px-3 py-3 font-medium text-muted-foreground">Tokens</th>
                <th className="text-center px-3 py-3 font-medium text-muted-foreground">HTML</th>
                <th className="text-center px-3 py-3 font-medium text-muted-foreground">CSS</th>
                <th className="text-center px-3 py-3 font-medium text-muted-foreground">JS</th>
                <th className="text-center px-3 py-3 font-medium text-muted-foreground">Reports</th>
                <th className="text-left px-3 py-3 font-medium text-muted-foreground">Updated</th>
                <th className="text-left px-3 py-3 font-medium text-muted-foreground">Health</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {templates.map(t => (
                <tr key={t.id} className="hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3">
                    <Link
                      href={`/reports/templates/${t.id}`}
                      className="font-medium text-foreground hover:text-primary transition-colors"
                    >
                      {t.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className={typeBadgeClass(t.template_type)}>
                      {typeLabel(t.template_type)}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-center text-muted-foreground">v{t.version}</td>
                  <td className="px-3 py-3 text-center">
                    <span className={t.slot_count === 0 ? 'text-amber-600 dark:text-amber-400 font-medium' : ''}>
                      {t.slot_count}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-center text-muted-foreground">{t.token_count}</td>
                  <td className="px-3 py-3 text-center"><ScaffoldDot present={t.scaffold_html} /></td>
                  <td className="px-3 py-3 text-center"><ScaffoldDot present={t.scaffold_css} /></td>
                  <td className="px-3 py-3 text-center"><ScaffoldDot present={t.scaffold_js} /></td>
                  <td className="px-3 py-3 text-center">
                    {t.reports_generated > 0
                      ? <span className="text-foreground font-medium">{t.reports_generated}</span>
                      : <span className="text-muted-foreground">—</span>
                    }
                  </td>
                  <td className="px-3 py-3 text-muted-foreground text-xs whitespace-nowrap">
                    {new Date(t.updated_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' })}
                  </td>
                  <td className="px-3 py-3">
                    <HealthBadge score={healthScore(t)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-6 text-xs text-muted-foreground pt-2">
        <span className="flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> Scaffold file present</span>
        <span className="flex items-center gap-1.5"><XCircle className="h-3.5 w-3.5 text-red-400" /> Scaffold file missing</span>
        <span className="flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> Warning — check required</span>
        <Link href="/reports/templates/new" className="ml-auto text-primary hover:underline">
          + New template
        </Link>
      </div>
    </div>
  )
}
