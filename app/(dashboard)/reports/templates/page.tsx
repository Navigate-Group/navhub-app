'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  FileText, Plus, BarChart2, Grid2X2, FileEdit, LayoutDashboard, Workflow,
  Clock, ChevronRight,
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { ReportTemplate, TemplateType } from '@/lib/types'

// ─── Type config ──────────────────────────────────────────────────────────────

const TYPE_CONFIG: Record<TemplateType, { label: string; Icon: React.ComponentType<{ className?: string }>; colour: string }> = {
  financial:  { label: 'Financial',  Icon: BarChart2,       colour: 'bg-blue-100   text-blue-700   dark:bg-blue-900/30   dark:text-blue-300'   },
  matrix:     { label: 'Matrix',     Icon: Grid2X2,         colour: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' },
  narrative:  { label: 'Narrative',  Icon: FileEdit,        colour: 'bg-green-100  text-green-700  dark:bg-green-900/30  dark:text-green-300'  },
  dashboard:  { label: 'Dashboard',  Icon: LayoutDashboard, colour: 'bg-amber-100  text-amber-700  dark:bg-amber-900/30  dark:text-amber-300'  },
  workflow:   { label: 'Workflow',   Icon: Workflow,         colour: 'bg-rose-100   text-rose-700   dark:bg-rose-900/30   dark:text-rose-300'   },
}

const FILTER_OPTIONS: Array<{ label: string; value: TemplateType | 'all' }> = [
  { label: 'All',        value: 'all'       },
  { label: 'Financial',  value: 'financial' },
  { label: 'Matrix',     value: 'matrix'    },
  { label: 'Narrative',  value: 'narrative' },
  { label: 'Dashboard',  value: 'dashboard' },
  { label: 'Workflow',   value: 'workflow'  },
]

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<ReportTemplate[]>([])
  const [filter,    setFilter]    = useState<TemplateType | 'all'>('all')
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [isAdmin,   setIsAdmin]   = useState(false)

  useEffect(() => {
    Promise.all([
      fetch('/api/report-templates').then(r => r.json()),
      fetch('/api/groups/active').then(r => r.json()),
    ])
      .then(([tmplJson, groupJson]) => {
        if (tmplJson.error) throw new Error(tmplJson.error)
        setTemplates(tmplJson.data ?? [])
        const role = groupJson.data?.role
        setIsAdmin(role === 'super_admin' || role === 'group_owner' || role === 'group_admin')
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const visible = filter === 'all'
    ? templates
    : templates.filter(t => t.template_type === filter)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Report Templates</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Reusable scaffolds for generating styled reports
          </p>
        </div>
        {isAdmin && (
          <Link
            href="/reports/templates/new"
            className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--palette-primary)' }}
          >
            <Plus className="h-4 w-4" />
            New Template
          </Link>
        )}
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        {FILTER_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => setFilter(opt.value)}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors',
              filter === opt.value
                ? 'border-primary text-primary bg-primary/10'
                : 'border-border text-muted-foreground hover:text-foreground hover:border-border'
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-44 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      )}

      {/* Error */}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Empty */}
      {!loading && !error && visible.length === 0 && (
        <Card>
          <CardContent className="pt-10 pb-10 text-center flex flex-col items-center gap-3">
            <FileText className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">No templates yet</p>
            <p className="text-xs text-muted-foreground max-w-xs">
              {filter === 'all'
                ? 'Create your first template to get started.'
                : `No ${filter} templates found. Try a different filter or create a new template.`}
            </p>
            {isAdmin && (
              <Link
                href="/reports/templates/new"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium text-white mt-2"
                style={{ backgroundColor: 'var(--palette-primary)' }}
              >
                <Plus className="h-4 w-4" />
                New Template
              </Link>
            )}
          </CardContent>
        </Card>
      )}

      {/* Grid */}
      {!loading && visible.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map(template => {
            const cfg = TYPE_CONFIG[template.template_type]
            const Icon = cfg.Icon
            return (
              <Card key={template.id} className="flex flex-col hover:border-primary/40 transition-colors">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className={cn('flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-semibold', cfg.colour)}>
                      <Icon className="h-3.5 w-3.5" />
                      {cfg.label}
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">v{template.version}</span>
                  </div>
                  <CardTitle className="text-sm mt-2 text-foreground leading-snug">{template.name}</CardTitle>
                  {template.description && (
                    <CardDescription className="text-xs line-clamp-2">{template.description}</CardDescription>
                  )}
                </CardHeader>
                <CardContent className="mt-auto pt-0">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-3">
                    <Clock className="h-3.5 w-3.5" />
                    Updated {formatDate(template.updated_at)}
                  </div>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/reports/templates/${template.id}/generate`}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-white text-center"
                      style={{ backgroundColor: 'var(--palette-primary)' }}
                    >
                      Generate Report
                    </Link>
                    <Link
                      href={`/reports/templates/${template.id}`}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-md border text-xs text-muted-foreground hover:text-foreground hover:border-border transition-colors"
                    >
                      View
                      <ChevronRight className="h-3 w-3" />
                    </Link>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
