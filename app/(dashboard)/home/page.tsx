'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Bot, FileText, BarChart3, DollarSign, Megaphone, LineChart,
  ArrowRight, Sparkles,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PermissionMatrix, FeatureKey } from '@/lib/types'

// Local (client-safe) mirror of lib/permissions#getVisibleFeatures. Inlined so
// this client component doesn't pull the server-only lib/permissions module
// (which imports the service-role admin client) into the browser bundle.
function visibleFeaturesFromMatrix(matrix: PermissionMatrix): FeatureKey[] {
  return (Object.keys(matrix) as FeatureKey[]).filter(f => {
    const def = matrix[f]?.['default'] ?? 'none'
    return def === 'view' || def === 'edit'
  })
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface HomeStatus {
  xero_connected:      boolean
  marketing_connected: boolean
  agent_count:         number
  document_count:      number
  markets_visible:     boolean
}

interface FeatureAccess {
  financials: boolean
  reports:    boolean
  documents:  boolean
  agents:     boolean
  marketing:  boolean
}

type TileState = { cta: string; href: string }

interface Tile {
  key:       string
  title:     string
  desc:      string
  Icon:      React.ComponentType<{ className?: string }>
  iconClass: string
  accent?:   boolean
  visible:   boolean
  state:     TileState
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

function todayFormatted(): string {
  return new Date().toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
}

// ── Component ────────────────────────────────────────────────────────────────────

export default function HomePage() {
  const [userName, setUserName] = useState('there')
  const [features, setFeatures] = useState<FeatureAccess>({
    financials: false, reports: false, documents: false, agents: false, marketing: false,
  })
  const [showMarkets, setShowMarkets] = useState(false)
  const [status, setStatus] = useState<HomeStatus>({
    xero_connected: false, marketing_connected: false, agent_count: 0, document_count: 0, markets_visible: false,
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [groupRes, permRes, statusRes] = await Promise.all([
          fetch('/api/groups/active'),
          fetch('/api/user/permissions'),
          fetch('/api/home/status'),
        ])

        const groupJson  = groupRes.ok  ? await groupRes.json()  : { data: null }
        const permJson   = permRes.ok   ? await permRes.json()   : { data: null }
        const statusJson = statusRes.ok ? await statusRes.json() : null

        if (cancelled) return

        setUserName(groupJson.data?.user_name?.split(' ')[0] ?? 'there')

        // Derive feature access from the permission matrix (feature → {default: level}).
        // Admins receive a full-edit matrix from the API, so this covers both cases.
        const matrix = (permJson.data?.matrix ?? {}) as PermissionMatrix
        const visible = visibleFeaturesFromMatrix(matrix)
        setFeatures({
          financials: visible.includes('financials'),
          reports:    visible.includes('reports'),
          documents:  visible.includes('documents'),
          agents:     visible.includes('agents'),
          marketing:  visible.includes('marketing'),
        })

        if (statusJson) {
          setStatus({
            xero_connected:      !!statusJson.xero_connected,
            marketing_connected: !!statusJson.marketing_connected,
            agent_count:         statusJson.agent_count ?? 0,
            document_count:      statusJson.document_count ?? 0,
            markets_visible:     !!statusJson.markets_visible,
          })
          setShowMarkets(!!statusJson.markets_visible)
        }
      } catch {
        /* silent — tiles render with default (disconnected) state */
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  const tiles: Tile[] = [
    {
      key: 'agents',
      title: 'Agents',
      desc: 'Configure AI agents to analyse data, generate reports, and automate tasks.',
      Icon: Bot,
      iconClass: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
      accent: true,
      visible: features.agents,
      state: {
        cta: status.agent_count > 0 ? 'View agents' : 'Create your first agent',
        href: '/agents',
      },
    },
    {
      key: 'documents',
      title: 'Documents',
      desc: 'Store, generate, and share business documents and files.',
      Icon: FileText,
      iconClass: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400',
      visible: features.documents,
      state: {
        cta: status.document_count > 0 ? 'View documents' : 'Upload a document',
        href: '/documents',
      },
    },
    {
      key: 'reports',
      title: 'Reports',
      desc: 'Build and publish financial and custom reports for your team.',
      Icon: BarChart3,
      iconClass: 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400',
      visible: features.reports,
      state: { cta: 'View reports', href: '/reports/custom' },
    },
    {
      key: 'financials',
      title: 'Financials',
      desc: 'Real-time P&L, balance sheet, and cash flow across your entities.',
      Icon: DollarSign,
      iconClass: 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400',
      visible: features.financials,
      state: status.xero_connected
        ? { cta: 'View financials', href: '/reports/profit-loss' }
        : { cta: 'Connect Xero', href: '/integrations' },
    },
    {
      key: 'marketing',
      title: 'Marketing',
      desc: 'Track marketing performance across GA4, Meta, and more.',
      Icon: Megaphone,
      iconClass: 'bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400',
      visible: features.marketing,
      state: status.marketing_connected
        ? { cta: 'View marketing', href: '/marketing' }
        : { cta: 'Connect GA4', href: '/marketing' },
    },
    {
      key: 'markets',
      title: 'Markets',
      desc: 'Explore market intelligence and country-level data.',
      Icon: LineChart,
      iconClass: 'bg-sky-100 text-sky-600 dark:bg-sky-900/30 dark:text-sky-400',
      visible: showMarkets,
      state: { cta: 'Explore markets', href: '/markets' },
    },
  ]

  const visibleTiles = tiles.filter(t => t.visible)

  if (loading) {
    return (
      <div className="space-y-8">
        <div className="space-y-2">
          <div className="h-8 w-64 bg-muted rounded animate-pulse" />
          <div className="h-4 w-48 bg-muted rounded animate-pulse" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map(i => (
            <div key={i} className="h-44 bg-muted rounded-xl animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-8 max-w-6xl mx-auto">
      {/* Greeting */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{greeting()}, {userName}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{todayFormatted()}</p>
      </div>

      {visibleTiles.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-10 text-center">
          <p className="text-muted-foreground">
            You don&apos;t have access to any features yet. Contact your administrator to get started.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleTiles.map(tile => (
            <FeatureTile key={tile.key} tile={tile} />
          ))}
        </div>
      )}

      {/* Assistant guidance strip */}
      <div className="rounded-xl border border-border bg-card p-5 flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="h-11 w-11 shrink-0 rounded-lg flex items-center justify-center bg-muted">
          <Sparkles className="h-5 w-5" style={{ color: 'var(--palette-primary)' }} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm">Not sure where to start?</p>
          <p className="text-sm text-muted-foreground mt-0.5">
            Ask the assistant to help you find the right feature, set something up, or answer a question.
            Open it any time from the bottom of the sidebar.
          </p>
        </div>
      </div>
    </div>
  )
}

// ── Tile ─────────────────────────────────────────────────────────────────────────

function FeatureTile({ tile }: { tile: Tile }) {
  const { title, desc, Icon, iconClass, accent, state } = tile
  return (
    <Link
      href={state.href}
      className={cn(
        'group flex flex-col rounded-xl border bg-card p-5 transition-all hover:shadow-md hover:border-foreground/20',
        accent ? 'border-blue-500/60 dark:border-blue-400/50' : 'border-border',
      )}
    >
      <div className={cn('h-11 w-11 rounded-lg flex items-center justify-center', iconClass)}>
        <Icon className="h-5 w-5" />
      </div>
      <h2 className="mt-4 font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground leading-relaxed flex-1">{desc}</p>
      <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
        {state.cta}
        <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  )
}
