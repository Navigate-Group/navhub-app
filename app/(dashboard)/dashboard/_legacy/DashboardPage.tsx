'use client'

/**
 * Legacy dashboard — preserved for reference. No longer mounted as a route.
 * The /dashboard route now redirects to the welcoming home page (/home).
 * See app/(dashboard)/dashboard/page.tsx.
 */

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  Building2, Bot, FileText, TrendingUp, DollarSign,
  BarChart2, ArrowRight,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge }  from '@/components/ui/badge'
import { cn }     from '@/lib/utils'
import { formatCurrency } from '@/lib/utils'
import type { NumberFormat } from '@/lib/types'

// ── Types ────────────────────────────────────────────────────────────────────

interface CompanyCard {
  id: string; name: string
  revenueMTD: number; grossMargin: number
  cashPosition: number; health: 'healthy' | 'review' | 'at_risk'
}

interface AgentRun {
  id: string; agent_name: string; status: string; created_at: string
}

interface RecentDoc {
  id: string; title: string; type: 'document' | 'report'; updated_at: string
}

interface FeatureAccess {
  financials: boolean; reports: boolean; documents: boolean
  agents: boolean; marketing: boolean
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

function todayFormatted(): string {
  return new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

const HEALTH_BADGE: Record<string, { label: string; cls: string }> = {
  healthy:  { label: 'Healthy',  cls: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
  review:   { label: 'Review',   cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  at_risk:  { label: 'At Risk',  cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
}

const STATUS_DOT: Record<string, string> = {
  completed: 'bg-green-500', running: 'bg-blue-500', awaiting_input: 'bg-amber-500', failed: 'bg-red-500',
}

// ── Component ────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [userName,   setUserName]   = useState('')
  const [features,   setFeatures]   = useState<FeatureAccess>({ financials: false, reports: false, documents: false, agents: false, marketing: false })
  const [companies,  setCompanies]  = useState<CompanyCard[]>([])
  const [agentRuns,  setAgentRuns]  = useState<AgentRun[]>([])
  const [recentDocs, setRecentDocs] = useState<RecentDoc[]>([])
  const [metrics,    setMetrics]    = useState({ revenueMTD: 0, cashPosition: 0, agentRuns7d: 0, docsPublished: 0 })
  const [loading,    setLoading]    = useState(true)
  const [numFmt,     setNumFmt]     = useState<NumberFormat>('smart')
  const [currency,   setCurrency]   = useState('AUD')

  const fmt = useCallback((v: number) => formatCurrency(v, numFmt, currency), [currency, numFmt])

  useEffect(() => {
    async function load() {
      try {
        const [groupRes, prefsRes, permRes] = await Promise.all([
          fetch('/api/groups/active'),
          fetch('/api/user/preferences'),
          fetch('/api/user/permissions'),
        ])
        const groupJson = await groupRes.json()
        const prefsJson = prefsRes.ok ? await prefsRes.json() : { data: null }
        const permJson  = permRes.ok ? await permRes.json() : { data: null }

        if (prefsJson.data) {
          if (prefsJson.data.currency) setCurrency(prefsJson.data.currency)
          if (prefsJson.data.number_format) setNumFmt(prefsJson.data.number_format)
        }

        // User name from group data
        setUserName(groupJson.data?.user_name?.split(' ')[0] ?? 'there')

        // Feature access
        const isAdmin = groupJson.data?.is_admin ?? false
        const perms: string[] = permJson.data?.features ?? []
        setFeatures({
          financials: isAdmin || perms.includes('financials'),
          reports:    isAdmin || perms.includes('reports'),
          documents:  isAdmin || perms.includes('documents'),
          agents:     isAdmin || perms.includes('agents'),
          marketing:  isAdmin || perms.includes('marketing'),
        })

        // Fetch data in parallel
        const fetches: Promise<void>[] = []

        // Companies + financial snapshots
        if (isAdmin || perms.includes('financials')) {
          fetches.push(
            fetch('/api/companies?include_inactive=false').then(r => r.json()).then(json => {
              const cards: CompanyCard[] = (json.data ?? []).map((c: { id: string; name: string }) => ({
                id: c.id, name: c.name, revenueMTD: 0, grossMargin: 0, cashPosition: 0, health: 'healthy' as const,
              }))
              setCompanies(cards)
            })
          )
        }

        // Agent runs
        if (isAdmin || perms.includes('agents')) {
          fetches.push(
            fetch('/api/agents/runs?limit=3').then(r => r.ok ? r.json() : { data: [] }).then(json => {
              setAgentRuns((json.data ?? []).slice(0, 3))
              setMetrics(prev => ({ ...prev, agentRuns7d: json.data?.length ?? 0 }))
            })
          )
        }

        // Recent docs + reports
        if (isAdmin || perms.includes('documents') || perms.includes('reports')) {
          fetches.push(
            Promise.all([
              fetch('/api/documents?status=published').then(r => r.ok ? r.json() : { data: [] }),
              fetch('/api/reports/custom?status=published').then(r => r.ok ? r.json() : { data: [] }),
            ]).then(([docsJson, repsJson]) => {
              const docs: RecentDoc[] = (docsJson.data ?? []).slice(0, 3).map((d: { id: string; title: string; updated_at: string }) => ({
                id: d.id, title: d.title, type: 'document' as const, updated_at: d.updated_at,
              }))
              const reps: RecentDoc[] = (repsJson.data ?? []).slice(0, 3).map((r: { id: string; name: string; updated_at: string }) => ({
                id: r.id, title: r.name, type: 'report' as const, updated_at: r.updated_at,
              }))
              const combined = [...docs, ...reps].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()).slice(0, 3)
              setRecentDocs(combined)
              setMetrics(prev => ({ ...prev, docsPublished: (docsJson.data?.length ?? 0) + (repsJson.data?.length ?? 0) }))
            })
          )
        }

        await Promise.allSettled(fetches)
      } catch { /* silent */ }
      setLoading(false)
    }
    void load()
  }, [])

  const hasAnyFeature = Object.values(features).some(Boolean)

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 bg-muted rounded w-64 animate-pulse" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => <div key={i} className="h-24 bg-muted rounded-xl animate-pulse" />)}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Greeting */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{greeting()}, {userName}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{todayFormatted()}</p>
      </div>

      {!hasAnyFeature && (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">Contact your administrator to get access to features.</p>
          </CardContent>
        </Card>
      )}

      {/* Overview metrics */}
      {hasAnyFeature && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {features.financials && (
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                    <DollarSign className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Revenue MTD</p>
                    <p className="text-lg font-bold">{fmt(metrics.revenueMTD)}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          {features.financials && (
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                    <TrendingUp className="h-5 w-5 text-green-600 dark:text-green-400" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Cash Position</p>
                    <p className="text-lg font-bold">{fmt(metrics.cashPosition)}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          {features.agents && (
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
                    <Bot className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Agent Runs (7d)</p>
                    <p className="text-lg font-bold">{metrics.agentRuns7d}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          {(features.documents || features.reports) && (
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                    <FileText className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Published</p>
                    <p className="text-lg font-bold">{metrics.docsPublished}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Companies */}
      {features.financials && companies.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Companies</h2>
            <Button variant="ghost" size="sm" className="h-7 text-xs" asChild>
              <Link href="/reports/profit-loss">View financials <ArrowRight className="h-3 w-3 ml-1" /></Link>
            </Button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {companies.map(c => {
              const hb = HEALTH_BADGE[c.health] ?? HEALTH_BADGE.healthy
              return (
                <Card key={c.id} className="hover:shadow-md transition-shadow">
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <p className="font-medium text-sm">{c.name}</p>
                      </div>
                      <Badge className={cn('text-[10px]', hb.cls)}>{hb.label}</Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div><p className="text-muted-foreground">Revenue MTD</p><p className="font-medium">{fmt(c.revenueMTD)}</p></div>
                      <div><p className="text-muted-foreground">Gross Margin</p><p className="font-medium">{c.grossMargin > 0 ? `${c.grossMargin.toFixed(1)}%` : '—'}</p></div>
                      <div><p className="text-muted-foreground">Cash</p><p className="font-medium">{fmt(c.cashPosition)}</p></div>
                      <div><p className="text-muted-foreground">Overdue AR</p><p className="font-medium">{fmt(0)}</p></div>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </div>
      )}

      {/* Widgets row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Agent Activity */}
        {features.agents && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Bot className="h-4 w-4" /> Agent Activity
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {agentRuns.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">No recent agent runs.</p>
              ) : agentRuns.map(run => (
                <div key={run.id} className="flex items-center gap-2 text-xs py-1">
                  <span className={cn('w-2 h-2 rounded-full shrink-0', STATUS_DOT[run.status] ?? 'bg-gray-400')} />
                  <span className="font-medium truncate flex-1">{run.agent_name ?? 'Agent'}</span>
                  <span className="text-muted-foreground shrink-0">{relativeTime(run.created_at)}</span>
                </div>
              ))}
              <Button variant="ghost" size="sm" className="w-full h-7 text-xs mt-1" asChild>
                <Link href="/agents">View all <ArrowRight className="h-3 w-3 ml-1" /></Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Cash Flow Preview */}
        {features.financials && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <BarChart2 className="h-4 w-4" /> Cash Flow
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground py-4 text-center">Connect Xero to see cash flow forecasts.</p>
              <Button variant="ghost" size="sm" className="w-full h-7 text-xs" asChild>
                <Link href="/cashflow">View forecast <ArrowRight className="h-3 w-3 ml-1" /></Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Recent Documents & Reports */}
        {(features.documents || features.reports) && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <FileText className="h-4 w-4" /> Recent Published
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {recentDocs.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">No published documents yet.</p>
              ) : recentDocs.map(doc => (
                <Link key={doc.id} href={doc.type === 'document' ? `/documents/${doc.id}` : `/reports/custom/${doc.id}`}
                  className="flex items-center gap-2 text-xs py-1 hover:bg-muted rounded px-1 -mx-1 transition-colors">
                  <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="font-medium truncate flex-1">{doc.title}</span>
                  <Badge variant="outline" className="text-[9px] shrink-0">{doc.type === 'document' ? 'Doc' : 'Report'}</Badge>
                </Link>
              ))}
              <Button variant="ghost" size="sm" className="w-full h-7 text-xs mt-1" asChild>
                <Link href="/documents">View all <ArrowRight className="h-3 w-3 ml-1" /></Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
