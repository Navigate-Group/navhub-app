'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft, CheckCircle2, XCircle, Loader2, Clock, Copy, Check,
  ChevronDown, ChevronRight, FileText, AlertCircle, ExternalLink, Library,
  Ban, MessageSquare, Send, CalendarClock, RotateCcw, X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge }  from '@/components/ui/badge'
import { cn }     from '@/lib/utils'
import CollapsibleSection from '@/components/ui/CollapsibleSection'
import type { Agent, AgentRun, RunStatus } from '@/lib/types'
import type { RunEvent } from '@/lib/agent-runner'

// ─── Tool display maps ─────────────────────────────────────────────────────────

const TOOL_EMOJI: Record<string, string> = {
  read_financials:        '📊',
  generate_report:        '📄',
  send_slack:             '💬',
  send_email:             '📧',
  list_report_templates:  '📋',
  read_report_template:   '🔍',
  create_report_template: '✨',
  update_report_template: '✏️',
  render_report:          '🖨️',
  analyse_document:       '🔬',
  list_documents:         '📂',
  read_document:          '📖',
  create_document:        '📝',
  update_document:        '✍️',
  ask_user:               '❓',
  read_attachment:        '📎',
}

const TOOL_LABEL: Record<string, string> = {
  read_financials:        'Read Financials',
  generate_report:        'Generate Report',
  send_slack:             'Send Slack',
  send_email:             'Send Email',
  list_report_templates:  'List Templates',
  read_report_template:   'Read Template',
  create_report_template: 'Create Template',
  update_report_template: 'Update Template',
  render_report:          'Render Report',
  analyse_document:       'Analyse Document',
  list_documents:         'List Documents',
  read_document:          'Read Document',
  create_document:        'Create Document',
  update_document:        'Update Document',
  ask_user:               'Ask User',
  read_attachment:        'Read Attachment',
}

// ─── Friendly tool → status text (shown in the live progress bar) ──────────

const TOOL_STATUS_MESSAGES: Record<string, string> = {
  read_attachment:       'Reading attached files…',
  read_document:         'Reading saved document…',
  list_documents:        'Searching documents…',
  read_financials:       'Retrieving financial data…',
  read_cashflow:         'Retrieving cash flow data…',
  read_cashflow_items:   'Reading cash flow items…',
  summarise_cashflow:    'Summarising cash flow…',
  create_document:       'Creating document…',
  update_document:       'Updating document…',
  render_report:         'Generating report…',
  generate_report:       'Generating report…',
  list_report_templates: 'Loading report templates…',
  read_report_template:  'Reading report template…',
  create_report_template: 'Creating report template…',
  update_report_template: 'Updating report template…',
  read_marketing_data:   'Retrieving marketing data…',
  summarise_marketing:   'Analysing marketing data…',
  ask_user:              'Waiting for your input…',
  send_slack:            'Sending Slack notification…',
  send_email:            'Sending email…',
  web_search:            'Searching the web…',
  analyse_document:      'Analysing document…',
}

// ─── Status config ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<RunStatus, { label: string; badgeClass: string }> = {
  queued:          { label: 'Queued',         badgeClass: 'bg-muted text-muted-foreground' },
  running:         { label: 'Running',        badgeClass: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300' },
  cancelling:      { label: 'Cancelling…',    badgeClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300' },
  success:         { label: 'Complete',       badgeClass: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' },
  error:           { label: 'Error',          badgeClass: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300' },
  cancelled:       { label: 'Cancelled',      badgeClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300' },
  awaiting_input:  { label: 'Awaiting Reply', badgeClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300' },
  // Recoverable limit terminal — amber, distinct from the red error state.
  paused:          { label: 'Limit Reached',  badgeClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300' },
  stuck:           { label: 'Stopped (Loop)', badgeClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300' },
}

// ─── Tool result summariser ────────────────────────────────────────────────────

function summariseTool(tool: string, output: string): string {
  try {
    const parsed = JSON.parse(output) as { success?: boolean; error?: string; data?: unknown; templates?: unknown[] }
    if (!parsed.success) return parsed.error ?? 'Failed'

    switch (tool) {
      case 'list_report_templates': {
        const list = Array.isArray(parsed.templates) ? parsed.templates : []
        const n = list.length
        return `Found ${n} template${n !== 1 ? 's' : ''}`
      }
      case 'read_report_template': {
        const d = parsed.data as { name?: string; slots?: unknown[] }
        return `${d?.name ?? 'Template'} — ${d?.slots?.length ?? 0} slots`
      }
      case 'create_report_template': {
        const d = parsed.data as { name?: string }
        return `Created: ${d?.name ?? 'template'}`
      }
      case 'update_report_template': {
        const d = parsed.data as { name?: string }
        return `Updated: ${d?.name ?? 'template'}`
      }
      case 'render_report': {
        const d = parsed.data as { report_name?: string }
        return `Rendered: ${d?.report_name ?? 'report'}`
      }
      case 'generate_report': {
        const d = parsed.data as { report_name?: string }
        return `Saved: ${d?.report_name ?? 'report'}`
      }
      case 'list_documents': {
        const n = Array.isArray(parsed.data) ? (parsed.data as unknown[]).length : 0
        return `Found ${n} document${n !== 1 ? 's' : ''}`
      }
      case 'read_document': {
        const d = parsed.data as { title?: string }
        return `Read: ${d?.title ?? 'document'}`
      }
      case 'create_document': {
        const d = parsed.data as { title?: string }
        return `Created: ${d?.title ?? 'document'}`
      }
      case 'update_document': {
        const d = parsed.data as { title?: string }
        return `Updated: ${d?.title ?? 'document'}`
      }
      case 'read_financials':
        return 'Financial data loaded'
      case 'send_email':
        return 'Email sent'
      case 'send_slack':
        return 'Slack message sent'
      case 'analyse_document':
        return 'Analysis complete'
      case 'ask_user':
        return 'User replied'
      case 'read_attachment': {
        const d = parsed as { file_name?: string; type?: string }
        return `Read: ${d?.file_name ?? 'attachment'}`
      }
      default: {
        const safe = output ?? ''
        return safe.length > 60 ? safe.slice(0, 57) + '…' : safe
      }
    }
  } catch {
    const safe = output ?? ''
    return safe.length > 60 ? safe.slice(0, 57) + '…' : safe
  }
}

// ─── Tool event type ───────────────────────────────────────────────────────────

interface ToolEventEntry {
  tool:           string
  input?:         Record<string, unknown>
  output?:        string
  inProgress:     boolean
  resultSummary?: string
}

// ─── Basic markdown renderer ───────────────────────────────────────────────────

function MarkdownText({ content }: { content: string }) {
  const lines = content.split('\n')
  return (
    <div className="space-y-1 font-mono text-sm leading-relaxed whitespace-pre-wrap">
      {lines.map((line, i) => {
        if (line.startsWith('### ')) return <p key={i} className="font-semibold text-base mt-3">{line.slice(4)}</p>
        if (line.startsWith('## '))  return <p key={i} className="font-bold text-lg mt-4">{line.slice(3)}</p>
        if (line.startsWith('# '))   return <p key={i} className="font-bold text-xl mt-4">{line.slice(2)}</p>
        if (line.startsWith('• ') || line.startsWith('- ')) return <p key={i} className="ml-4">{line}</p>
        if (line.startsWith('  ')) return <p key={i} className="ml-6 text-muted-foreground">{line}</p>
        return <p key={i}>{line || '\u00A0'}</p>
      })}
    </div>
  )
}

// ─── Timeline entry ────────────────────────────────────────────────────────────

function TimelineEntry({ entry }: { entry: ToolEventEntry }) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const emoji = TOOL_EMOJI[entry.tool] ?? '🔧'
  const label = TOOL_LABEL[entry.tool] ?? entry.tool.replace(/_/g, ' ')

  return (
    <div className="flex items-start gap-2.5">
      <div className="shrink-0 w-4 mt-[3px]">
        {entry.inProgress
          ? <span className="inline-block h-2.5 w-2.5 rounded-full bg-blue-500 animate-pulse" />
          : <CheckCircle2 className="h-4 w-4 text-green-500" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-sm">
          <span>{emoji}</span>
          <span className={cn('font-medium', entry.inProgress && 'text-blue-600 dark:text-blue-400')}>
            {label}
          </span>
          {entry.inProgress && (
            <span className="text-xs text-muted-foreground animate-pulse">running…</span>
          )}
        </div>
        {!entry.inProgress && entry.resultSummary && (
          <p className="text-xs text-muted-foreground mt-0.5 ml-0.5">→ {entry.resultSummary}</p>
        )}
        {!entry.inProgress && (entry.input !== undefined || entry.output !== undefined) && (
          <button
            onClick={() => setDetailsOpen(d => !d)}
            className="flex items-center gap-0.5 text-xs text-muted-foreground/60 hover:text-muted-foreground mt-1 transition-colors"
          >
            {detailsOpen
              ? <ChevronDown  className="h-3 w-3" />
              : <ChevronRight className="h-3 w-3" />}
            Details
          </button>
        )}
        {detailsOpen && (
          <div className="mt-2 space-y-2 text-[11px] font-mono">
            {entry.input && Object.keys(entry.input).length > 0 && (
              <div>
                <p className="text-muted-foreground font-sans font-medium text-[10px] mb-1 uppercase tracking-wide">Input</p>
                <pre className="bg-muted/40 p-2 rounded overflow-x-auto">{JSON.stringify(entry.input, null, 2)}</pre>
              </div>
            )}
            {entry.output && (
              <div>
                <p className="text-muted-foreground font-sans font-medium text-[10px] mb-1 uppercase tracking-wide">Output</p>
                <pre className="bg-muted/40 p-2 rounded overflow-x-auto whitespace-pre-wrap">
                  {entry.output.slice(0, 1200)}{entry.output.length > 1200 ? '\n… (truncated)' : ''}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Card renderers ────────────────────────────────────────────────────────────

function renderDocCards(toolEvents: ToolEventEntry[]) {
  return toolEvents
    .filter(te => te.tool === 'create_document' && !te.inProgress && !!te.output)
    .flatMap((te, i) => {
      try {
        const parsed = JSON.parse(te.output!) as {
          success?: boolean
          data?: { document_id?: string; title?: string; document_type?: string; audience?: string }
        }
        if (parsed.success && parsed.data?.document_id) {
          const d = parsed.data as { document_id: string; title: string; document_type?: string; audience?: string }
          return [(
            <div
              key={`doc-${i}`}
              className="flex items-center justify-between gap-3 rounded-lg border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950 px-4 py-3"
            >
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-blue-800 dark:text-blue-300 truncate">
                    {d.title || 'Document created'}
                  </p>
                  {(d.document_type || d.audience) && (
                    <p className="text-xs text-blue-600 dark:text-blue-400">
                      {[d.document_type?.replace(/_/g, ' '), d.audience].filter(Boolean).join(' · ')}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
                  <Link href={`/documents/${d.document_id}`}>
                    <ExternalLink className="h-3 w-3 mr-1" /> Open
                  </Link>
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
                  <Link href="/documents">
                    <Library className="h-3 w-3 mr-1" /> Documents
                  </Link>
                </Button>
              </div>
            </div>
          )]
        }
      } catch { /* non-JSON */ }
      return []
    })
}

function renderReportCards(toolEvents: ToolEventEntry[]) {
  return toolEvents
    .filter(te => te.tool === 'render_report' && !te.inProgress && !!te.output)
    .flatMap((te, i) => {
      try {
        const parsed = JSON.parse(te.output!) as {
          success?: boolean
          data?: { report_id?: string; report_name?: string }
        }
        if (parsed.success && parsed.data?.report_id) {
          const d = parsed.data as { report_id: string; report_name: string }
          return [(
            <div
              key={`report-${i}`}
              className="flex items-center justify-between gap-3 rounded-lg border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950 px-4 py-3"
            >
              <span className="text-sm font-medium text-green-800 dark:text-green-300 flex items-center gap-2">
                <FileText className="h-4 w-4 shrink-0" />
                {d.report_name || 'Report generated'}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
                  <Link href={`/view/report/${d.report_id}`} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3 w-3 mr-1" /> View Report
                  </Link>
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
                  <Link href="/reports/custom">
                    <Library className="h-3 w-3 mr-1" /> Library
                  </Link>
                </Button>
              </div>
            </div>
          )]
        }
      } catch { /* non-JSON */ }
      return []
    })
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 3600) {
    const m = Math.floor(s / 60).toString().padStart(2, '0')
    const r = (s % 60).toString().padStart(2, '0')
    return `${m}:${r}`
  }
  const h = Math.floor(s / 3600).toString().padStart(2, '0')
  const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0')
  const r = (s % 60).toString().padStart(2, '0')
  return `${h}:${m}:${r}`
}

// ─── Run stream page ───────────────────────────────────────────────────────────

export default function RunStreamPage() {
  const params = useParams<{ runId: string }>()
  const router = useRouter()

  const [agent,         setAgent]         = useState<Agent | null>(null)
  const [run,           setRun]           = useState<AgentRun | null>(null)
  const [status,        setStatus]        = useState<RunStatus>('queued')
  const [textOutput,    setTextOutput]    = useState('')
  // Mirror of textOutput so we can preserve streamed output across renders
  // even if the DB hydration hasn't yet caught the cancel flush.
  const savedOutputRef = useRef('')
  // Stored newest-first so the UI renders newest at top without reversing
  const [toolEvents,    setToolEvents]    = useState<ToolEventEntry[]>([])
  const [tokens,        setTokens]        = useState(0)
  const [errorMsg,      setErrorMsg]      = useState<string | null>(null)
  // Legible limit / pause state — populated when a run hits a recoverable
  // ceiling (rate-limit exhaustion, iteration cap) or a stuck loop. Surfaced
  // as a distinct amber card, separate from the red error block. `pauseStuck`
  // suppresses the "Run again" affordance for a looping agent.
  const [pauseReason,   setPauseReason]   = useState<string | null>(null)
  const [pauseStuck,    setPauseStuck]    = useState(false)
  const [loading,       setLoading]       = useState(true)
  const [durationSecs,  setDurationSecs]  = useState(0)
  // Live elapsed-time clock — ticks every second while the run is active
  // and freezes once the run hits a terminal status. estimatedSeconds is
  // parsed from the agent's "⏱ Estimated time: X minutes" preamble, when
  // present, so we can render a "~Nmin remaining" countdown.
  const [elapsedSeconds,   setElapsedSeconds]   = useState(0)
  const [estimatedSeconds, setEstimatedSeconds] = useState<number | null>(null)
  const [cancelConfirm,  setCancelConfirm]  = useState(false)
  const [cancelling,     setCancelling]     = useState(false)
  const [copied,         setCopied]         = useState(false)
  const [awaitingInput,  setAwaitingInput]  = useState<{ question: string; interaction_id: string } | null>(null)
  const [replyText,      setReplyText]      = useState('')
  const [sendingReply,   setSendingReply]   = useState(false)
  const [replyError,     setReplyError]     = useState<string | null>(null)
  const [attachments,    setAttachments]    = useState<Array<{ file_name: string; file_type: string; file_size: number | null }>>([])

  // ── Live progress + follow-up state ─────────────────────────────────────
  const [currentStatus,  setCurrentStatus]  = useState<string>('Starting…')
  const [followUpText,   setFollowUpText]   = useState('')
  const [queuedFollowUp, setQueuedFollowUp] = useState<string | null>(null)
  interface FollowUpEntry { brief: string; output: string; status: 'queued' | 'running' | 'success' | 'error' }
  const [followUpThread, setFollowUpThread] = useState<FollowUpEntry[]>([])

  const topRef = useRef<HTMLDivElement>(null)

  // Scroll to top of output as new text arrives (content is at top of page)
  useEffect(() => {
    topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])   // only on mount — we don't want to keep jumping to top on every chunk

  // Fetch attachments for this run
  useEffect(() => {
    fetch(`/api/agents/runs/${params.runId}/attachments`)
      .then(r => r.json())
      .then((j: { data?: Array<{ file_name: string; file_type: string; file_size: number | null }> }) => {
        if (j.data) setAttachments(j.data)
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.runId])

  const loadMetaAndStream = useCallback(async () => {
    const infoRes = await fetch(`/api/agents/runs/${params.runId}/info`).catch(() => null)
    let initialStatus: RunStatus | null = null
    let runRow: AgentRun | null = null
    if (infoRes?.ok) {
      const infoJson = await infoRes.json()
      runRow = (infoJson.data?.run ?? null) as AgentRun | null
      if (runRow)               setRun(runRow)
      if (infoJson.data?.agent) setAgent(infoJson.data.agent)
      if (runRow?.status)       { setStatus(runRow.status); initialStatus = runRow.status }
    }
    setLoading(false)

    // ── Always connect to the SSE stream ──────────────────────────────────
    // The stream route now polls the DB and replays saved state for
    // terminal runs. No more separate hydration path — the same handler
    // services live + replay cases.
    const r0 = (runRow ?? {}) as Partial<{
      tokens_used:   number | null
      error_message: string | null
      started_at:    string | null
      completed_at:  string | null
    }>
    if (typeof r0.tokens_used === 'number') setTokens(r0.tokens_used)
    if (r0.error_message)                   setErrorMsg(r0.error_message)
    // Hydrate the limit/pause card for an already-terminal run on first load.
    // A `stuck`/`error` row whose pause_reason is set is a loop guard — flag it.
    if (runRow?.pause_reason) {
      setPauseReason(runRow.pause_reason)
      if (runRow.status === 'stuck' || (runRow.status === 'error' && runRow.pause_reason)) {
        setPauseStuck(runRow.status === 'stuck' || runRow.pause_reason.startsWith('stuck_loop'))
      }
    }

    const runRes = await fetch(`/api/agents/runs/${params.runId}/stream`).catch(() => null)
    if (!runRes?.ok || !runRes.body) {
      setErrorMsg(`Stream error: ${runRes?.status ?? 'unknown'}`)
      return
    }

    // For replayed terminal runs the stream emits a `done`/`cancelled`/`error`
    // event almost immediately. Anchor `start` to the actual run start time
    // when available so the displayed duration reflects the real elapsed
    // wall-clock — not the time since the page opened.
    const start = r0.started_at ? new Date(r0.started_at).getTime() : Date.now()
    if (!initialStatus || initialStatus === 'queued' || initialStatus === 'running') {
      setStatus('running')
    }
    // Helper: prefer DB-recorded completion time when computing duration so
    // replayed terminal runs show the real run length, not page-open delta.
    const computeDuration = () => {
      if (r0.started_at && r0.completed_at) {
        return Math.round((new Date(r0.completed_at).getTime() - new Date(r0.started_at).getTime()) / 1000)
      }
      return Math.round((Date.now() - start) / 1000)
    }

    const reader  = runRes.body.getReader()
    const decoder = new TextDecoder()
    let buffer    = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        let event: RunEvent
        try { event = JSON.parse(line.slice(6)) as RunEvent }
        catch { continue }

        if (event.type === 'text') {
          setTextOutput(prev => {
            const next = prev + event.content
            savedOutputRef.current = next
            return next
          })
          // Switch the progress label off "Starting…" the moment text begins flowing
          setCurrentStatus(prev => (prev === 'Starting…' ? 'Writing output…' : prev))
        } else if (event.type === 'tool_start') {
          // PREPEND so newest is at the top of the list
          setToolEvents(prev => [{ tool: event.tool, input: event.input, inProgress: true }, ...prev])
          setCurrentStatus(TOOL_STATUS_MESSAGES[event.tool] ?? `Running ${event.tool}…`)
        } else if (event.type === 'tool_end') {
          const summary = summariseTool(event.tool, event.output ?? '')
          setToolEvents(prev => {
            // Find the first (topmost) matching in-progress entry and complete it
            let found = false
            return prev.map(te => {
              if (!found && te.tool === event.tool && te.inProgress) {
                found = true
                return { ...te, output: event.output, inProgress: false, resultSummary: summary }
              }
              return te
            })
          })
        } else if (event.type === 'done') {
          setTokens(event.tokens)
          setStatus('success')
          setDurationSecs(computeDuration())
        } else if (event.type === 'error') {
          setErrorMsg(event.message)
          setStatus('error')
          setDurationSecs(computeDuration())
        } else if (event.type === 'cancelled') {
          setStatus('cancelled')
          // Re-hydrate output from the ref in case any state churn cleared
          // textOutput before the DB save catches up.
          if (savedOutputRef.current) setTextOutput(savedOutputRef.current)
          setDurationSecs(computeDuration())
        } else if (event.type === 'paused') {
          // Recoverable limit terminal — show the amber card, NOT the red
          // error block. `stuck` events come through here too (flagged) so a
          // looping agent is visibly distinct from a re-runnable limit.
          setPauseReason(event.reason)
          setPauseStuck(!!event.stuck)
          setStatus(event.stuck ? 'stuck' : 'paused')
          if (typeof event.tokens === 'number') setTokens(event.tokens)
          if (savedOutputRef.current) setTextOutput(savedOutputRef.current)
          setDurationSecs(computeDuration())
        } else if (event.type === 'awaiting_input') {
          setStatus('awaiting_input')
          setAwaitingInput({ question: event.question, interaction_id: event.interaction_id })
        }
      }
    }
  }, [params.runId])

  useEffect(() => { void loadMetaAndStream() }, [loadMetaAndStream])

  async function handleCancel() {
    setCancelling(true)
    const res = await fetch(`/api/agents/runs/${params.runId}/cancel`, { method: 'POST' })
    if (!res.ok) setCancelConfirm(false)
    setCancelling(false)
    setCancelConfirm(false)
  }

  async function handleCopyOutput() {
    await navigator.clipboard.writeText(textOutput)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  /** Build the /agents/[id]/run URL carrying every persisted run setting. */
  function buildRunAgainUrl(r: typeof run, recurring: boolean) {
    if (!r?.agent_id) return
    const params = new URLSearchParams()
    const r2 = r as unknown as {
      input_context?:        { extra_instructions?: string }
      run_name?:             string | null
      output_folder_id?:     string | null
      output_status?:        string | null
      output_type?:          string | null
      output_name_override?: string | null
      notify_email?:         string | null
      notify_slack_channel?: string | null
      task_complexity?:      string | null
    }
    if (r2.input_context?.extra_instructions) params.set('brief', r2.input_context.extra_instructions)
    // Strip the "Follow-up: " prefix when re-running — the new run isn't a
    // follow-up of itself, just another execution of the original brief.
    if (r2.run_name) {
      const cleanedName = r2.run_name.replace(/^Follow-up:\s*/i, '')
      if (cleanedName) params.set('name', cleanedName)
    }
    if (r2.output_folder_id)                  params.set('folder_id',     r2.output_folder_id)
    if (r2.output_status)                     params.set('status',        r2.output_status)
    if (r2.output_type)                       params.set('output_type',   r2.output_type)
    if (r2.output_name_override)              params.set('output_name',   r2.output_name_override)
    if (r2.notify_email)                      params.set('notify_email',  r2.notify_email)
    if (r2.notify_slack_channel)              params.set('notify_slack',  r2.notify_slack_channel)
    if (r2.task_complexity && r2.task_complexity !== 'standard')
                                              params.set('task_complexity', r2.task_complexity)
    if (recurring)                            params.set('recurring',     'true')
    const qs = params.toString()
    router.push(`/agents/${r.agent_id}/run${qs ? `?${qs}` : ''}`)
  }

  // ── Follow-up: post a new run with this agent + brief, stream it inline ──
  const startFollowUp = useCallback(async (brief: string) => {
    if (!run?.agent_id) return
    const idx = followUpThread.length
    setFollowUpThread(prev => [...prev, { brief, output: '', status: 'queued' }])

    try {
      const createRes = await fetch(`/api/agents/${run.agent_id}/run`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          extra_instructions: brief,
          run_name:           `Follow-up: ${brief.slice(0, 50)}`,
          // Link to the originating run so the API can prepend the parent's
          // output to the extra_instructions for context-aware continuation.
          parent_run_id:      params.runId,
        }),
      })
      const createJson = await createRes.json() as { data?: { run_id?: string }; error?: string }
      const newRunId   = createJson.data?.run_id
      if (!newRunId) {
        setFollowUpThread(prev => {
          const next = [...prev]
          next[idx] = { ...next[idx], status: 'error', output: createJson.error ?? 'Failed to start follow-up' }
          return next
        })
        return
      }

      // Stream via the same SSE endpoint the main run uses
      const sseRes = await fetch(`/api/agents/runs/${newRunId}/stream`)
      if (!sseRes.ok || !sseRes.body) {
        setFollowUpThread(prev => {
          const next = [...prev]
          next[idx] = { ...next[idx], status: 'error', output: 'Stream connection failed' }
          return next
        })
        return
      }
      setFollowUpThread(prev => {
        const next = [...prev]
        next[idx] = { ...next[idx], status: 'running' }
        return next
      })

      const reader  = sseRes.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          let event: RunEvent
          try { event = JSON.parse(line.slice(6)) as RunEvent } catch { continue }
          if (event.type === 'text') {
            setFollowUpThread(prev => {
              const next = [...prev]
              next[idx] = { ...next[idx], output: next[idx].output + event.content }
              return next
            })
          } else if (event.type === 'done' || event.type === 'error' || event.type === 'cancelled' || event.type === 'paused') {
            setFollowUpThread(prev => {
              const next = [...prev]
              next[idx] = {
                ...next[idx],
                status: event.type === 'done' ? 'success' : 'error',
                ...(event.type === 'paused' ? { output: next[idx].output + `\n\n⚠️ ${event.reason}` } : {}),
              }
              return next
            })
          }
        }
      }
    } catch (err) {
      setFollowUpThread(prev => {
        const next = [...prev]
        next[idx] = { ...next[idx], status: 'error', output: err instanceof Error ? err.message : String(err) }
        return next
      })
    }
  }, [run, followUpThread.length, params.runId])

  async function handleFollowUp() {
    const brief = followUpText.trim()
    if (!brief) return
    setFollowUpText('')
    if (isRunning) {
      // Queue — fires when the parent run reaches a terminal status
      setQueuedFollowUp(brief)
      return
    }
    void startFollowUp(brief)
  }

  // When the parent run finishes, drain any queued follow-up
  useEffect(() => {
    if (!queuedFollowUp) return
    if (status === 'success' || status === 'error' || status === 'cancelled') {
      const brief = queuedFollowUp
      setQueuedFollowUp(null)
      void startFollowUp(brief)
    }
  }, [status, queuedFollowUp, startFollowUp])

  async function handleSendReply() {
    if (!awaitingInput || !replyText.trim()) return
    setSendingReply(true)
    setReplyError(null)
    try {
      const res = await fetch(`/api/agents/runs/${params.runId}/respond`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ interaction_id: awaitingInput.interaction_id, answer: replyText.trim() }),
      })
      if (!res.ok) {
        const json = await res.json()
        setReplyError((json as { error?: string }).error ?? 'Failed to send reply')
      } else {
        // Clear the input card — the runner will resume and emit further events
        setAwaitingInput(null)
        setReplyText('')
        setStatus('running')
      }
    } catch {
      setReplyError('Network error — please try again')
    } finally {
      setSendingReply(false)
    }
  }

  const cfg       = STATUS_CONFIG[status] ?? STATUS_CONFIG.queued
  const isDone    = status === 'success' || status === 'error' || status === 'cancelled' || status === 'paused' || status === 'stuck'
  const isActive  = status === 'running' || status === 'awaiting_input' || status === 'cancelling'
  const isRunning = status === 'queued' || status === 'running'

  // ── Live elapsed-time clock ──────────────────────────────────────────────
  // Ticks every second while the run is active. When the run finishes we
  // stop the interval and pin elapsedSeconds to the recorded duration.
  useEffect(() => {
    if (!run?.started_at) return
    const startMs = new Date(run.started_at).getTime()
    const tick = () => {
      const end = run?.completed_at ? new Date(run.completed_at).getTime() : Date.now()
      setElapsedSeconds(Math.max(0, Math.floor((end - startMs) / 1000)))
    }
    tick()
    if (!isActive) return
    const handle = setInterval(tick, 1000)
    return () => clearInterval(handle)
  }, [run?.started_at, run?.completed_at, isActive])

  // ── Parse "⏱ Estimated time: N minutes" from the agent's preamble ───────
  // Anchors the countdown indicator. Re-runs on textOutput change but only
  // sets the estimate once (so subsequent agent text doesn't reset it).
  useEffect(() => {
    if (estimatedSeconds !== null) return
    if (!textOutput) return
    const match = textOutput.match(/⏱\s*Estimated time:\s*(\d+)\s*minute/i)
    if (match) setEstimatedSeconds(parseInt(match[1], 10) * 60)
  }, [textOutput, estimatedSeconds])

  // ── Derived values for section badges ──
  const completedToolCount = toolEvents.filter(te => !te.inProgress).length

  const activityBadge = isDone
    ? `${completedToolCount} tool call${completedToolCount !== 1 ? 's' : ''} · ${durationSecs}s`
    : undefined

  const wordCount   = textOutput.trim() ? textOutput.trim().split(/\s+/).length : 0
  const outputBadge = isDone
    ? (errorMsg ? 'Error' : (textOutput ? `~${wordCount.toLocaleString()} words` : status === 'cancelled' ? 'Cancelled' : ''))
    : undefined

  const promptText = run?.input_context?.extra_instructions ?? ''
  const briefBadge = promptText
    ? (promptText.length > 60 ? promptText.slice(0, 57) + '…' : promptText)
    : 'No additional instructions'

  const modelLabel = run?.model_used
    ? run.model_used.includes('opus')        ? 'Claude Opus 4'
    : run.model_used.includes('sonnet')      ? 'Claude Sonnet 4'
    : run.model_used.includes('haiku')       ? 'Claude Haiku'
    : run.model_used === 'gpt-4o'            ? 'GPT-4o'
    : run.model_used.includes('gpt-4o-mini') ? 'GPT-4o Mini'
    : run.model_used.includes('gemini')      ? 'Gemini'
    : run.model_used.includes('mistral')     ? 'Mistral'
    : run.model_used
    : null

  const docCards    = renderDocCards(toolEvents)
  const reportCards = renderReportCards(toolEvents)

  const showOutput = textOutput.length > 0 || isDone

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div ref={topRef} />

      {/* ── Sticky toolbar — always visible ── */}
      <div className="sticky top-0 z-10 bg-background border-b pb-3 -mx-1 px-1 pt-1">
        <div className="flex items-center gap-3 flex-wrap">
          <Button variant="ghost" size="sm" asChild>
            <Link href={run?.agent_id ? `/agents/${run.agent_id}/runs` : '/agents'}>
              <ArrowLeft className="h-4 w-4 mr-1" /> Run History
            </Link>
          </Button>
          {agent && (
            <div
              className="h-8 w-8 rounded-full flex items-center justify-center text-xs font-semibold text-white shrink-0"
              style={{ backgroundColor: agent.avatar_color }}
            >
              {agent.name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{agent?.name ?? 'Agent'}</p>
          </div>
          <Badge className={cn('gap-1', cfg.badgeClass)}>
            {status === 'running'        && <Loader2        className="h-3 w-3 animate-spin" />}
            {status === 'awaiting_input' && <MessageSquare  className="h-3 w-3" />}
            {status === 'success'        && <CheckCircle2   className="h-3 w-3" />}
            {status === 'error'          && <XCircle        className="h-3 w-3" />}
            {status === 'cancelled'      && <Ban            className="h-3 w-3" />}
            {(status === 'paused' || status === 'stuck') && <AlertCircle className="h-3 w-3" />}
            {cfg.label}
          </Badge>
          {run?.triggered_by === 'schedule' && (
            <Badge className="gap-1 text-xs font-normal bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
              <Clock className="h-3 w-3" />
              Scheduled
            </Badge>
          )}
          {/* Queued hint — runs are picked up by /api/cron/process-queued-runs
              within a minute, so explain the wait rather than just showing a
              silent "Queued" pill. */}
          {status === 'queued' && (
            <span className="text-xs text-muted-foreground italic">
              Starting in a moment…
            </span>
          )}
          {run?.started_at && (
            <>
              {/* Started-at clock (static) */}
              <span className="text-xs text-muted-foreground flex items-center gap-1" title={new Date(run.started_at).toLocaleString()}>
                <Clock className="h-3 w-3" />
                {new Date(run.started_at).toLocaleTimeString()}
              </span>
              {/* Live elapsed timer — pulses while active, freezes on terminal */}
              <span className={cn(
                'text-xs font-mono flex items-center gap-1.5',
                isActive ? 'text-primary' : 'text-muted-foreground',
              )}>
                {formatElapsed(elapsedSeconds)}
                {isActive && (
                  <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                )}
              </span>
              {/* Countdown from the agent's own estimate, if it gave one */}
              {estimatedSeconds !== null && isActive && (
                <span className="text-[11px] text-muted-foreground">
                  {(() => {
                    const remaining = estimatedSeconds - elapsedSeconds
                    if (remaining > 0)  return `~${Math.ceil(remaining / 60)}min remaining`
                    const over = Math.ceil(-remaining / 60)
                    return `${over}min over estimate`
                  })()}
                </span>
              )}
            </>
          )}

          {/* Cancel button — while running or awaiting input */}
          {isActive && status !== 'cancelling' && !cancelConfirm && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-950"
              onClick={() => setCancelConfirm(true)}
            >
              <Ban className="h-3.5 w-3.5 mr-1.5" /> Cancel Run
            </Button>
          )}
          {status === 'cancelling' && (
            <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Cancelling…
            </div>
          )}
          {isActive && status !== 'cancelling' && cancelConfirm && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground">Cancel this run?</span>
              <Button
                size="sm" variant="outline"
                className="h-7 text-xs border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400"
                onClick={() => void handleCancel()}
                disabled={cancelling}
              >
                {cancelling && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                Confirm
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs"
                onClick={() => setCancelConfirm(false)} disabled={cancelling}>
                Nevermind
              </Button>
            </div>
          )}
        </div>

        {/* ── Action row: Run Again / Make Recurring + follow-up input ── */}
        {run?.agent_id && (
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => buildRunAgainUrl(run, false)}
              title="Re-run with the same brief on this agent"
            >
              <RotateCcw className="h-3 w-3 mr-1.5" /> Run Again
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => buildRunAgainUrl(run, true)}
              title="Schedule this brief on a recurring schedule"
            >
              <CalendarClock className="h-3 w-3 mr-1.5" /> Make Recurring
            </Button>

            <div className="w-px h-5 bg-border mx-0.5" />

            <input
              type="text"
              value={followUpText}
              onChange={e => setFollowUpText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && followUpText.trim()) {
                  e.preventDefault()
                  void handleFollowUp()
                }
              }}
              placeholder={
                isRunning
                  ? 'Type a follow-up — will fire once this run finishes…'
                  : 'Ask the agent for a follow-up…'
              }
              className="flex-1 min-w-[200px] h-7 text-xs rounded-md border border-input bg-background px-3 focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <Button
              size="sm"
              className="h-7 text-xs gap-1.5"
              onClick={() => void handleFollowUp()}
              disabled={!followUpText.trim()}
            >
              {isRunning ? <Clock className="h-3 w-3" /> : <Send className="h-3 w-3" />}
              {isRunning ? 'Queue' : 'Send'}
            </Button>
          </div>
        )}

        {/* Queued follow-up indicator */}
        {queuedFollowUp && (
          <div className="mt-2 flex items-center gap-2 px-3 py-1.5 rounded-md bg-amber-100 dark:bg-amber-950/40 text-xs text-amber-700 dark:text-amber-300">
            <Clock className="h-3 w-3 shrink-0" />
            <span className="flex-1 truncate">
              Follow-up queued: &ldquo;{queuedFollowUp.length > 80 ? queuedFollowUp.slice(0, 77) + '…' : queuedFollowUp}&rdquo;
            </span>
            <button
              onClick={() => setQueuedFollowUp(null)}
              className="text-amber-500 hover:text-amber-700 dark:hover:text-amber-100"
              title="Cancel queued follow-up"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* ── Live activity strip ── shown only while the run is in flight.
            Displays a status line (driven by currentStatus) plus the most
            recent tool events so users can see exactly what the agent is
            doing right now, without having to scroll to the full Activity
            section further down. */}
        {isRunning && (
          <div className="mt-2 space-y-1.5">
            {/* Indeterminate progress bar — same as before */}
            <div className="h-0.5 rounded-full overflow-hidden bg-muted">
              <div className="h-full rounded-full bg-primary animate-progress-indeterminate" />
            </div>

            {/* Status line — uses currentStatus, which the SSE handler bumps
                on every tool_start. Falls back to "Working…" between calls. */}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin shrink-0" />
              <span className="truncate">{currentStatus}</span>
            </div>

            {/* Recent tool events — newest first, capped at 4 rows. Spinner
                for in-progress, check for complete. Same data the Activity
                CollapsibleSection below uses; this is the live mirror so
                users can see the timeline without expanding anything. */}
            {toolEvents.length > 0 && (
              <ul className="rounded-md border bg-muted/20 divide-y divide-border/50">
                {toolEvents.slice(0, 4).map((te, i) => {
                  const emoji = TOOL_EMOJI[te.tool] ?? '🔧'
                  const label = TOOL_LABEL[te.tool] ?? te.tool.replace(/_/g, ' ')
                  return (
                    <li key={i} className="flex items-center gap-2 text-xs px-2.5 py-1.5">
                      {te.inProgress
                        ? <span className="inline-block h-2 w-2 rounded-full bg-blue-500 animate-pulse shrink-0" />
                        : <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />}
                      <span className="shrink-0">{emoji}</span>
                      <span className={cn('truncate', te.inProgress ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-foreground')}>
                        {label}
                      </span>
                      {te.inProgress
                        ? <span className="ml-auto text-[10px] text-muted-foreground animate-pulse shrink-0">running…</span>
                        : te.resultSummary
                          ? <span className="ml-auto text-[10px] text-muted-foreground truncate max-w-[40%]">→ {te.resultSummary}</span>
                          : null}
                    </li>
                  )
                })}
                {toolEvents.length > 4 && (
                  <li className="px-2.5 py-1 text-[10px] text-muted-foreground italic">
                    + {toolEvents.length - 4} earlier · expand Activity for the full timeline
                  </li>
                )}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* ── Follow-up thread — newest first, ABOVE the original output so the
          conversation reads top-down. The original run section is auto-
          collapsed once any follow-up exists. ── */}
      {followUpThread.length > 0 && (
        <div className="space-y-3">
          {[...followUpThread].reverse().map((entry, reversedIdx) => {
            const i        = followUpThread.length - 1 - reversedIdx
            const isLatest = i === followUpThread.length - 1
            return (
            <CollapsibleSection
              key={i}
              title={`Follow-up ${i + 1}`}
              defaultOpen={isLatest}
              badge={
                entry.status === 'running' ? 'Running…'
                : entry.status === 'queued'  ? 'Queued'
                : entry.status === 'error'   ? 'Error'
                : entry.output ? `~${entry.output.trim().split(/\s+/).length.toLocaleString()} words` : undefined
              }
            >
              <div className="space-y-3 pt-0.5">
                <div className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Brief:</span> {entry.brief}
                </div>
                {entry.output && (
                  <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
                    {entry.output}
                    {entry.status === 'running' && (
                      <span className="inline-block w-2 h-4 -mb-0.5 align-middle bg-muted-foreground/60 animate-pulse ml-0.5" />
                    )}
                  </pre>
                )}
                {entry.status === 'running' && !entry.output && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Agent working…
                  </div>
                )}
              </div>
            </CollapsibleSection>
            )
          })}
        </div>
      )}

      {/* ── Original run output — below follow-ups, collapses once a follow-up
          exists so the latest exchange is what the user sees first. ── */}
      {showOutput && (
        <CollapsibleSection
          title={followUpThread.length > 0 ? 'Original run' : 'Output'}
          defaultOpen={followUpThread.length === 0}
          badge={outputBadge}
        >
          <div className="space-y-3 pt-0.5">

            {/* Model + tokens meta — shown when done */}
            {isDone && (modelLabel ?? tokens > 0) && (
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {modelLabel && <span>{modelLabel}</span>}
                  {tokens > 0 && <span>· {tokens.toLocaleString()} tokens</span>}
                </div>
                {(() => {
                  const tier = ((run as { task_complexity?: string } | null)?.task_complexity ?? 'standard') as
                    'standard' | 'medium' | 'large' | 'massive' | 'professional'
                  // Per-tier warn / hard-warn thresholds.
                  const tierThresholds: Record<string, { warn: number; hard: number; suggest: string | null }> = {
                    standard:     { warn:  20_000, hard:    60_000, suggest: 'medium'       },
                    medium:       { warn:  60_000, hard:   150_000, suggest: 'large'        },
                    large:        { warn: 120_000, hard:   250_000, suggest: 'massive'      },
                    massive:      { warn: 200_000, hard:   400_000, suggest: 'professional' },
                    professional: { warn: 400_000, hard: 1_000_000, suggest: null           },
                  }
                  const thresholds = tierThresholds[tier] ?? tierThresholds.standard
                  if (tokens > thresholds.hard) {
                    return (
                      <div className="text-amber-400 text-xs">
                        ⚠️ Very high token usage ({tokens.toLocaleString()} tokens).
                        {thresholds.suggest && ` For tasks of this size, try the "${thresholds.suggest}" tier on the run form so the agent plans iterations accordingly.`}
                      </div>
                    )
                  }
                  if (tokens > thresholds.warn) {
                    return (
                      <div className="text-amber-400 text-xs">
                        ⚠️ High token usage for this tier — consider simplifying the brief or reducing enabled tools
                      </div>
                    )
                  }
                  return null
                })()}
              </div>
            )}

            {/* Limit / pause card — amber, distinct from the red error block.
                Shown when a run hit a recoverable ceiling (rate-limit
                exhaustion, iteration cap) or a stuck loop. A re-runnable limit
                offers "Run Again"; a stuck loop deliberately does NOT, since
                re-running as-is would just loop again. */}
            {pauseReason && (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-3 py-2.5">
                <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <div className="space-y-2">
                  <div>
                    <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                      {pauseStuck ? 'Stopped — possible loop detected' : 'Limit reached — partial output saved'}
                    </p>
                    <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5 break-words">{pauseReason}</p>
                  </div>
                  {!pauseStuck && run?.agent_id && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs border-amber-300 dark:border-amber-700"
                      onClick={() => buildRunAgainUrl(run, false)}
                      title="Re-run this brief — optionally at a larger task size"
                    >
                      <RotateCcw className="h-3 w-3 mr-1.5" /> Run Again
                    </Button>
                  )}
                </div>
              </div>
            )}

            {/* Error block — suppressed when a pause_reason is present, since
                that case is already surfaced by the amber limit card above. */}
            {errorMsg && !pauseReason && (
              <div className="flex items-start gap-2 rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950 px-3 py-2.5">
                <AlertCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-red-800 dark:text-red-300">Error</p>
                  <p className="text-xs text-red-600 dark:text-red-400 mt-0.5 break-words">{errorMsg}</p>
                </div>
              </div>
            )}

            {/* Document + Report cards */}
            {(docCards.length > 0 || reportCards.length > 0) && (
              <div className="space-y-2">
                {docCards}
                {reportCards}
              </div>
            )}

            {/* Text output — streams live and shown when done */}
            {textOutput && (
              <div>
                {isDone && (
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Response</p>
                    <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => void handleCopyOutput()}>
                      {copied
                        ? <><Check className="h-3 w-3 mr-1" /> Copied</>
                        : <><Copy  className="h-3 w-3 mr-1" /> Copy</>}
                    </Button>
                  </div>
                )}
                <MarkdownText content={textOutput} />
                {/* Streaming cursor */}
                {status === 'running' && (
                  <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-0.5 rounded-sm" />
                )}

              </div>
            )}

            {/* Cancelled with no output */}
            {status === 'cancelled' && !textOutput && !errorMsg && docCards.length === 0 && reportCards.length === 0 && (
              <p className="text-sm text-amber-600 dark:text-amber-400 italic">
                Run was cancelled before producing output.
              </p>
            )}

            {/* Run Again / Make Recurring moved to the sticky top bar */}
          </div>
        </CollapsibleSection>
      )}

      {/* ── Awaiting input reply card ── */}
      {awaitingInput && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 p-4 space-y-3">
          <div className="flex items-start gap-2">
            <MessageSquare className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">Agent needs your input</p>
              <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">{awaitingInput.question}</p>
            </div>
          </div>
          <div className="flex items-end gap-2">
            <textarea
              className="flex-1 resize-none rounded-md border border-amber-300 dark:border-amber-700 bg-white dark:bg-amber-900/30 text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-500 min-h-[60px]"
              placeholder="Type your reply…"
              value={replyText}
              onChange={e => setReplyText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleSendReply()
                }
              }}
              disabled={sendingReply}
            />
            <Button
              size="sm"
              className="h-9 bg-amber-600 hover:bg-amber-700 text-white shrink-0"
              onClick={() => void handleSendReply()}
              disabled={sendingReply || !replyText.trim()}
            >
              {sendingReply
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Send    className="h-3.5 w-3.5" />}
              <span className="ml-1.5">{sendingReply ? 'Sending…' : 'Send'}</span>
            </Button>
          </div>
          {replyError && (
            <p className="text-xs text-red-600 dark:text-red-400">{replyError}</p>
          )}
        </div>
      )}

      {/* ── 2. Activity section — tool timeline, newest at top ── */}
      <CollapsibleSection title="Activity" defaultOpen={true} badge={activityBadge}>
        <div className="space-y-3">
          {/* Thinking indicator — shown before first tool call and not awaiting input */}
          {status === 'running' && toolEvents.length === 0 && (
            <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-blue-400 animate-pulse shrink-0" />
              Thinking…
            </div>
          )}

          {/* Tool call timeline — newest first (prepended on arrival) */}
          {toolEvents.map((te, i) => (
            <TimelineEntry key={i} entry={te} />
          ))}

          {/* Empty state for completed run with no tools */}
          {isDone && toolEvents.length === 0 && (
            <p className="text-sm text-muted-foreground italic">No tool calls in this run</p>
          )}
        </div>
      </CollapsibleSection>

      {/* ── 3. Brief section — collapsed, anchored at bottom ── */}
      <CollapsibleSection title="Brief" defaultOpen={false} badge={briefBadge}>
        <div className="space-y-3 pt-0.5">
          {/* Prompt / extra instructions */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Prompt</p>
            {promptText ? (
              <p className="text-sm text-foreground leading-relaxed">{promptText}</p>
            ) : (
              <p className="text-sm text-muted-foreground italic">No additional instructions</p>
            )}
          </div>

          {/* Agent + model */}
          {agent && (
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Agent</p>
              <span className="text-sm">{agent.name}</span>
              {modelLabel && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{modelLabel}</Badge>
              )}
            </div>
          )}

          {/* Tools */}
          {agent && (agent.tools?.length ?? 0) > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Tools</p>
              <div className="flex flex-wrap gap-1">
                {(agent.tools ?? []).map(t => (
                  <Badge key={t} variant="secondary" className="text-[10px] px-1.5 py-0">
                    {TOOL_LABEL[t] ?? t.replace(/_/g, ' ')}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Period context */}
          {run?.input_context?.period && (
            <div className="flex items-center gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Period</p>
              <span className="text-sm">{run.input_context.period}</span>
            </div>
          )}

          {/* Attachments */}
          {attachments.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Attachments</p>
              <div className="flex flex-wrap gap-1.5">
                {attachments.map(att => (
                  <span
                    key={att.file_name}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-muted text-muted-foreground border border-border"
                  >
                    📎 {att.file_name}
                    {att.file_size != null && (
                      <span className="opacity-60">({(att.file_size / 1024).toFixed(0)} KB)</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </CollapsibleSection>

      {/* ── Chat continuation ── */}
      {run?.status === 'success' && (
        <ContinueChat runId={params.runId as string} />
      )}

    </div>
  )
}

// ── Chat continuation component ──────────────────────────────────────────────

function ContinueChat({ runId }: { runId: string }) {
  const [messages, setMessages] = useState<Array<{ id: string; role: string; content: string; created_at: string }>>([])
  const [input, setInput]       = useState('')
  const [sending, setSending]   = useState(false)

  useEffect(() => {
    fetch(`/api/agents/runs/${runId}/messages`).then(r => r.json()).then(json => setMessages(json.data ?? [])).catch(() => {})
  }, [runId])

  async function handleSend() {
    if (!input.trim() || sending) return
    setSending(true)
    const content = input.trim()
    setInput('')
    // Optimistic user message
    setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'user', content, created_at: new Date().toISOString() }])

    try {
      const res = await fetch(`/api/agents/runs/${runId}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      if (res.ok) {
        // Refresh messages
        const msgRes = await fetch(`/api/agents/runs/${runId}/messages`)
        if (msgRes.ok) { const json = await msgRes.json(); setMessages(json.data ?? []) }
      }
    } catch { /* ignore */ }
    setSending(false)
  }

  return (
    <div className="border-t pt-6 mt-6 space-y-4">
      <h3 className="text-sm font-semibold">Continue this run</h3>

      {messages.length > 0 && (
        <div className="space-y-3 max-h-80 overflow-y-auto">
          {messages.map(msg => (
            <div key={msg.id} className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div className={cn(
                'rounded-lg px-3 py-2 max-w-[80%] text-sm',
                msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'
              )}>
                <p className="whitespace-pre-wrap">{msg.content}</p>
                <p className="text-[10px] opacity-60 mt-1">
                  {new Date(msg.created_at).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend() } }}
          placeholder="Type a follow-up message…"
          className="flex-1 h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          disabled={sending}
        />
        <Button size="sm" onClick={() => void handleSend()} disabled={sending || !input.trim()}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  )
}
