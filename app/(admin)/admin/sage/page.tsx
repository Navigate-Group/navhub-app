'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { Search, ExternalLink, CheckCircle2, Clock, GitBranch, Rocket } from 'lucide-react'
import type {
  SageFinding, SageScan, SageSeverity, SageFindingStatus, SageActionType, SageEscalation, UserSuggestion,
} from '@/lib/types'

const SEVERITY_STYLE: Record<SageSeverity, { dot: string; tag: string; label: string }> = {
  critical: { dot: 'bg-red-500',    tag: 'bg-red-500/15 text-red-300 border-red-500/30',         label: 'CRITICAL' },
  warning:  { dot: 'bg-amber-500',  tag: 'bg-amber-500/15 text-amber-300 border-amber-500/30',   label: 'WARNING'  },
  info:     { dot: 'bg-sky-500',    tag: 'bg-sky-500/15 text-sky-300 border-sky-500/30',         label: 'INFO'     },
  positive: { dot: 'bg-emerald-500', tag: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', label: 'POSITIVE' },
}

const ACTION_LABEL: Record<SageActionType, string> = {
  operator_can_act:   'OPERATOR_CAN_ACT',
  escalate_to_builder: 'ESCALATE_TO_BUILDER',
  awareness:          'AWARENESS',
}

// Status-only pill — severity / type / action filters are separate dropdowns
// so multiple dimensions can be combined.
type StatusFilter = 'open' | 'all' | 'acknowledged' | 'resolved' | 'dismissed'

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'open',         label: 'Open' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'resolved',     label: 'Resolved' },
  { value: 'dismissed',    label: 'Dismissed' },
  { value: 'all',          label: 'All' },
]

type Tab = 'overview' | 'feedback' | 'investigations' | 'escalations'

// Feedback filter types
type FeedbackFilter = 'open' | 'submitted' | 'triaged' | 'acknowledged' | 'declined' | 'shipped' | 'all'

interface EnrichedSuggestion extends UserSuggestion {
  submitter_email: string | null
  group_name:      string | null
}

const FEEDBACK_FILTERS: { value: FeedbackFilter; label: string }[] = [
  { value: 'open',         label: 'Open'         },
  { value: 'submitted',    label: 'Submitted'    },
  { value: 'triaged',      label: 'Triaged'      },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'declined',     label: 'Declined'     },
  { value: 'shipped',      label: 'Shipped'      },
  { value: 'all',          label: 'All'          },
]

export default function AdminSagePage() {
  const [tab,       setTab]       = useState<Tab>('overview')
  const [findings,  setFindings]  = useState<SageFinding[]>([])
  const [scans,     setScans]     = useState<SageScan[]>([])
  const [escalations, setEscalations] = useState<SageEscalation[]>([])
  const [groupMap,  setGroupMap]  = useState<Record<string, string>>({})
  const [loading,   setLoading]   = useState(true)
  const [status,    setStatus]    = useState<StatusFilter>('open')
  const [search,    setSearch]    = useState('')
  const [severity,  setSeverity]  = useState<string>('all')
  const [action,    setAction]    = useState<string>('all')
  const [findType,  setFindType]  = useState<string>('all')
  const [scanOpen,  setScanOpen]  = useState(false)
  const [scanType,  setScanType]  = useState<'adhoc' | 'requested'>('adhoc')
  const [focusArea, setFocusArea] = useState('')
  const [periodDays, setPeriodDays] = useState(7)
  const [scanBusy,  setScanBusy]  = useState(false)
  const [toast,     setToast]     = useState<string | null>(null)

  // Feedback tab state
  const [suggestions, setSuggestions] = useState<EnrichedSuggestion[]>([])
  const [feedbackFilter, setFeedbackFilter] = useState<FeedbackFilter>('open')
  const [feedbackLoading, setFeedbackLoading] = useState(false)
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [respondTo, setRespondTo] = useState<EnrichedSuggestion | null>(null)

  // Handle hash-based navigation (e.g., /admin/sage#feedback)
  useEffect(() => {
    const hash = window.location.hash.slice(1) as Tab | ''
    if (hash && ['overview', 'feedback', 'investigations', 'escalations'].includes(hash)) {
      setTab(hash as Tab)
    }
  }, [])

  // Escalation state
  const [escalationModalOpen, setEscalationModalOpen] = useState(false)
  const [escalatingFinding, setEscalatingFinding] = useState<SageFinding | null>(null)
  const [escalationBusy, setEscalationBusy] = useState(false)
  const [escalationFilter, setEscalationFilter] = useState<string>('all')
  const [escalationPriorityFilter, setEscalationPriorityFilter] = useState<string>('all')

  // Operator-driven investigation card — surfaced at the top of the page so
  // ops can submit a specific symptom for Sage to investigate without going
  // through the suggestions inbox first.
  const [investigationOpen, setInvestigationOpen]   = useState(false)
  const [investigationBrief, setInvestigationBrief] = useState('')
  const [investigationBusy,  setInvestigationBusy]  = useState(false)

  async function handleRunInvestigation() {
    if (!investigationBrief.trim()) return
    setInvestigationBusy(true)
    try {
      const res  = await fetch('/api/admin/sage/scan', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          scan_type:   'requested',
          focus_area:  investigationBrief.trim(),
          period_days: 30,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Scan failed')
      setToast('Investigation started')
      setInvestigationOpen(false)
      setInvestigationBrief('')
      loadAll()
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Scan failed')
    } finally {
      setInvestigationBusy(false)
    }
  }

  // ── Feedback tab functions ────────────────────────────────────────────────
  const loadFeedback = useCallback(() => {
    setFeedbackLoading(true)
    const params = new URLSearchParams()
    if (feedbackFilter === 'open')      params.set('status', 'submitted,triaged,acknowledged,acting')
    if (feedbackFilter === 'submitted') params.set('status', 'submitted')
    if (feedbackFilter === 'triaged')   params.set('status', 'triaged')
    if (feedbackFilter === 'acknowledged') params.set('status', 'acknowledged,acting')
    if (feedbackFilter === 'declined')  params.set('status', 'declined')
    if (feedbackFilter === 'shipped')   params.set('status', 'shipped')
    if (feedbackFilter === 'all')       params.set('status', 'submitted,triaged,acknowledged,acting,declined,shipped')

    fetch(`/api/admin/suggestions?${params.toString()}`)
      .then(r => r.json())
      .then((j: { data?: EnrichedSuggestion[] }) => setSuggestions(j.data ?? []))
      .finally(() => setFeedbackLoading(false))
  }, [feedbackFilter])

  useEffect(() => {
    if (tab === 'feedback') loadFeedback()
  }, [tab, loadFeedback])

  function setBusy(id: string, on: boolean) {
    setBusyIds(prev => {
      const next = new Set(prev)
      if (on) next.add(id); else next.delete(id)
      return next
    })
  }

  async function patchSuggestionStatus(id: string, status: string) {
    setBusy(id, true)
    try {
      const res = await fetch(`/api/admin/suggestions/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ status }),
      })
      if (!res.ok) throw new Error('Update failed')
      setToast(`Marked ${status}`)
      loadFeedback()
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setBusy(id, false)
    }
  }

  async function triageWithSage(id: string) {
    setBusy(id, true)
    try {
      const res  = await fetch(`/api/admin/suggestions/${id}/triage`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Triage failed')
      setToast('Triaged')
      loadFeedback()
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Triage failed')
    } finally {
      setBusy(id, false)
    }
  }

  async function submitToSage(s: EnrichedSuggestion) {
    setBusy(s.id, true)
    try {
      const focusArea = [
        'User feedback investigation:',
        `User: ${s.submitter_email ?? 'unknown'}`,
        `Group: ${s.group_name ?? 'unknown'}`,
        '',
        `What they were trying to do: ${s.what_trying}`,
        `What happened: ${s.what_happened}`,
        `What they wanted: ${s.what_wanted}`,
        '',
        'Investigate this specific user experience issue. Look for:',
        '- Permission configuration issues for this user/group',
        '- Recent errors or failed runs in this group',
        '- Agent or document access issues',
        '- Any platform configuration that could cause this symptom',
      ].join('\n')

      const res  = await fetch('/api/admin/sage/scan', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          scan_type:   'requested',
          focus_area:  focusArea,
          period_days: 30,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Scan failed')
      setToast('Sage is investigating')
      await patchSuggestionStatus(s.id, 'triaged')
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Scan failed')
    } finally {
      setBusy(s.id, false)
    }
  }

  const loadAll = useCallback(() => {
    setLoading(true)
    // Always fetch the broadest status set the current filter would allow,
    // then refine in-memory. Keeps the search + severity + action filters
    // snappy (no round-trip per keystroke) and the response cacheable.
    const params = new URLSearchParams()
    if (status === 'open')         params.set('status', 'new,acknowledged,acting')
    else if (status === 'all')     params.set('status', 'new,acknowledged,acting,resolved,dismissed')
    else if (status === 'acknowledged') params.set('status', 'acknowledged,acting')
    else                           params.set('status', status)

    Promise.all([
      fetch(`/api/admin/sage/findings?${params.toString()}`).then(r => r.json()),
      fetch('/api/admin/sage/scans?limit=10').then(r => r.json()),
      fetch('/api/admin/sage/escalations').then(r => r.json()),
    ])
      .then(([fJson, sJson, eJson]) => {
        setFindings((fJson.data ?? []) as SageFinding[])
        setScans((sJson.data ?? []) as SageScan[])
        setEscalations((eJson.data ?? []) as SageEscalation[])
      })
      .finally(() => setLoading(false))
  }, [status])
  useEffect(() => { loadAll() }, [status, loadAll])

  async function handleEscalateFinding(finding: SageFinding) {
    setEscalatingFinding(finding)
    setEscalationModalOpen(true)
  }

  async function submitEscalation(operatorContext: string) {
    if (!escalatingFinding) return
    setEscalationBusy(true)
    try {
      const res = await fetch('/api/admin/sage/escalations', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          finding_id: escalatingFinding.id,
          trigger_type: 'admin_interaction',
          summary: escalatingFinding.title,
          detail: [
            `**Finding:** ${escalatingFinding.title}`,
            '',
            `**Observation:** ${escalatingFinding.observation}`,
            '',
            `**Interpretation:** ${escalatingFinding.interpretation}`,
            '',
            escalatingFinding.recommendation ? `**Recommendation:** ${escalatingFinding.recommendation}` : '',
            '',
            operatorContext ? `**Operator Context:** ${operatorContext}` : '',
          ].filter(Boolean).join('\n'),
          suggested_priority: escalatingFinding.severity === 'critical' ? 'critical'
                            : escalatingFinding.severity === 'warning' ? 'high'
                            : 'medium',
          source_context: {
            scan_id: escalatingFinding.scan_id,
            finding_id: escalatingFinding.id,
          },
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Escalation failed')
      setToast('Escalation sent to Builder')
      setEscalationModalOpen(false)
      setEscalatingFinding(null)
      loadAll()
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Escalation failed')
    } finally {
      setEscalationBusy(false)
    }
  }

  // Load group id → name map once for resolving affected_groups UUIDs into
  // friendly names on each finding card.
  useEffect(() => {
    fetch('/api/admin/groups')
      .then(r => r.json())
      .then((j: { data?: Array<{ id: string; name: string }> }) => {
        const m: Record<string, string> = {}
        for (const g of j.data ?? []) m[g.id] = g.name
        setGroupMap(m)
      })
      .catch(() => {})
  }, [])

  // Client-side refinement on top of the server-side status fetch.
  const visibleFindings = useMemo(() => {
    return findings.filter(f => {
      if (severity !== 'all' && f.severity    !== severity) return false
      if (action   !== 'all' && f.action_type !== action)   return false
      if (findType !== 'all' && f.finding_type !== findType) return false
      if (search.trim()) {
        const q = search.toLowerCase()
        const haystack = [
          f.title, f.observation, f.interpretation, f.recommendation ?? '',
        ].join(' ').toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [findings, severity, action, findType, search])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(t)
  }, [toast])

  async function patchFinding(id: string, status: SageFindingStatus, dismissedReason?: string) {
    const res = await fetch(`/api/admin/sage/findings/${id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status, ...(dismissedReason !== undefined ? { dismissed_reason: dismissedReason } : {}) }),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setToast(`Update failed: ${j.error ?? res.status}`)
      return
    }
    setToast(`Marked ${status}`)
    loadAll()
  }

  async function runAdhocScan() {
    setScanBusy(true)
    try {
      const res = await fetch('/api/admin/sage/scan', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          scan_type:   scanType,
          focus_area:  scanType === 'requested' ? focusArea.trim() || undefined : undefined,
          period_days: periodDays,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Scan failed')
      setToast('Scan complete')
      setScanOpen(false)
      setFocusArea('')
      loadAll()
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Scan failed')
    } finally {
      setScanBusy(false)
    }
  }

  const lastCompleted = useMemo(() => scans.find(s => s.status === 'complete') ?? null, [scans])

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Sage — Platform Intelligence</h1>
          <p className="text-xs text-zinc-400 mt-0.5">
            {lastCompleted
              ? `Last scan: ${formatDate(lastCompleted.completed_at ?? lastCompleted.started_at)} · ${lastCompleted.scan_type}`
              : 'No scans yet — run one to see findings.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
        <button
          onClick={() => setInvestigationOpen(o => !o)}
          className="text-xs px-3 py-1.5 rounded border border-violet-700 text-violet-300 hover:bg-violet-950/30 inline-flex items-center gap-1.5"
        >
          <Search className="h-3.5 w-3.5" /> Submit issue for investigation
        </button>
        <div className="relative">
          <button
            onClick={() => setScanOpen(o => !o)}
            className="text-xs px-3 py-1.5 rounded bg-amber-500 text-zinc-900 font-semibold hover:bg-amber-400"
          >
            Run scan now ▾
          </button>
          {scanOpen && (
            <div className="absolute right-0 mt-2 w-80 bg-zinc-900 border border-zinc-800 rounded-lg p-3 z-10 space-y-2 shadow-lg">
              <label className="flex items-center gap-2 text-xs text-zinc-300">
                <input
                  type="radio"
                  checked={scanType === 'adhoc'}
                  onChange={() => setScanType('adhoc')}
                />
                Full adhoc scan
              </label>
              <label className="flex items-start gap-2 text-xs text-zinc-300">
                <input
                  type="radio"
                  className="mt-1"
                  checked={scanType === 'requested'}
                  onChange={() => setScanType('requested')}
                />
                <div className="flex-1 space-y-1">
                  Focused scan
                  <input
                    value={focusArea}
                    onChange={e => setFocusArea(e.target.value)}
                    placeholder="What should Sage focus on?"
                    className="w-full h-8 px-2 text-xs rounded border border-zinc-700 bg-zinc-950 text-zinc-100"
                    onClick={() => setScanType('requested')}
                  />
                </div>
              </label>
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                Lookback (days):
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={periodDays}
                  onChange={e => setPeriodDays(Math.max(1, Math.min(90, parseInt(e.target.value, 10) || 7)))}
                  className="w-16 h-7 px-2 text-xs rounded border border-zinc-700 bg-zinc-950 text-zinc-100"
                />
              </label>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setScanOpen(false)}
                  className="text-xs px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                  disabled={scanBusy}
                >Cancel</button>
                <button
                  onClick={runAdhocScan}
                  className="text-xs px-3 py-1 rounded bg-amber-500 text-zinc-900 font-semibold hover:bg-amber-400"
                  disabled={scanBusy}
                >{scanBusy ? 'Running…' : 'Run scan'}</button>
              </div>
            </div>
          )}
        </div>
        </div>
      </div>

      {/* Operator-driven investigation form — when the operator wants to
          submit a specific symptom or question for Sage to investigate. */}
      {investigationOpen && (
        <div className="border border-violet-800 rounded-lg p-4 space-y-3 bg-violet-950/20">
          <div>
            <p className="text-sm font-semibold text-violet-200">Submit issue to Sage</p>
            <p className="text-[11px] text-violet-300/70 mt-0.5">
              Describe a specific symptom or question. Sage will run a focused 30-day investigation.
            </p>
          </div>
          <textarea
            value={investigationBrief}
            onChange={e => setInvestigationBrief(e.target.value)}
            placeholder="e.g. User mark@axistech.co in AxisTech Rural cannot add documents. Add Documents button is greyed out despite being a group admin."
            rows={4}
            className="w-full px-3 py-2 rounded border border-zinc-700 bg-zinc-950 text-zinc-100 text-xs"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => { setInvestigationOpen(false); setInvestigationBrief('') }}
              disabled={investigationBusy}
              className="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            >Cancel</button>
            <button
              onClick={handleRunInvestigation}
              disabled={investigationBusy || !investigationBrief.trim()}
              className="text-xs px-3 py-1.5 rounded bg-violet-500 text-zinc-950 font-semibold hover:bg-violet-400 disabled:opacity-60"
            >{investigationBusy ? 'Investigating…' : 'Investigate with Sage'}</button>
          </div>
        </div>
      )}

      {/* Phase 1 IA: Tab navigation (Overview | Feedback | Investigations | Escalations) */}
      <div className="flex items-center gap-1 border-b border-zinc-800">
        {(['overview', 'feedback', 'investigations', 'escalations'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-sm px-4 py-2 capitalize border-b-2 transition-colors ${
              tab === t
                ? 'border-amber-500 text-amber-300 font-medium'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab: Overview — latest scan summary + critical findings */}
      {tab === 'overview' && (
        <div className="space-y-4">
          <p className="text-xs text-zinc-400">
            Latest scan summary, critical findings, and quick actions. Full findings list in Investigations tab.
          </p>
          {lastCompleted && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">Latest scan</p>
              <p className="text-sm text-zinc-200">{lastCompleted.summary || 'No summary'}</p>
              <p className="text-xs text-zinc-400">
                {formatDate(lastCompleted.completed_at ?? lastCompleted.started_at)} · {lastCompleted.scan_type} · {lastCompleted.findings_count} findings ({lastCompleted.critical_count} critical)
              </p>
            </div>
          )}
          <p className="text-xs text-zinc-500">
            For detailed findings, switch to the <button onClick={() => setTab('investigations')} className="text-amber-400 hover:underline">Investigations</button> tab.
          </p>
        </div>
      )}

      {/* Tab: Feedback — unified suggestions list with Sage triage */}
      {tab === 'feedback' && (
        <div className="space-y-4">
          <p className="text-xs text-zinc-400">
            Unified feedback inbox (support requests, feature suggestions, user reports). Sage triages new submissions on demand.
          </p>

          {/* Feedback filter pills */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {FEEDBACK_FILTERS.map(f => (
              <button
                key={f.value}
                onClick={() => setFeedbackFilter(f.value)}
                className={`text-xs px-2.5 py-1 rounded border ${
                  feedbackFilter === f.value
                    ? 'border-amber-500 bg-amber-500/10 text-amber-300'
                    : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {feedbackLoading ? (
            <p className="text-sm text-zinc-400">Loading…</p>
          ) : suggestions.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-800 p-10 text-center">
              <p className="text-sm text-zinc-400">No suggestions in this view.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {suggestions.map(s => (
                <FeedbackCard
                  key={s.id}
                  suggestion={s}
                  busy={busyIds.has(s.id)}
                  onTriage={() => triageWithSage(s.id)}
                  onSubmitToSage={() => submitToSage(s)}
                  onAck={() => patchSuggestionStatus(s.id, 'acknowledged')}
                  onActing={() => patchSuggestionStatus(s.id, 'acting')}
                  onDecline={() => patchSuggestionStatus(s.id, 'declined')}
                  onShipped={() => patchSuggestionStatus(s.id, 'shipped')}
                  onRespond={() => setRespondTo(s)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab: Escalations — Phase 2: Interactive Requirements frame */}
      {tab === 'escalations' && (
        <div className="space-y-4">
          <p className="text-xs text-zinc-400">
            Escalations sent to Builder&apos;s Kaizen, with status-return tracking.
          </p>

          {/* Filters: Status and Priority */}
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={escalationFilter}
              onChange={e => setEscalationFilter(e.target.value)}
              className="text-xs h-8 px-2 rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
            >
              <option value="all">All statuses</option>
              <option value="drafted">Drafted</option>
              <option value="sent">Sent</option>
              <option value="acknowledged">Acknowledged</option>
              <option value="acted">Acted</option>
              <option value="declined">Declined</option>
            </select>
            <select
              value={escalationPriorityFilter}
              onChange={e => setEscalationPriorityFilter(e.target.value)}
              className="text-xs h-8 px-2 rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
            >
              <option value="all">All priorities</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
            <span className="text-xs text-zinc-500 ml-auto">
              {escalations.filter(e =>
                (escalationFilter === 'all' || e.status === escalationFilter) &&
                (escalationPriorityFilter === 'all' || e.suggested_priority === escalationPriorityFilter)
              ).length} escalation{escalations.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Escalations list */}
          {loading ? (
            <p className="text-sm text-zinc-400">Loading…</p>
          ) : escalations.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-800 p-10 text-center">
              <p className="text-sm text-zinc-400">No escalations yet.</p>
              <p className="text-xs text-zinc-500 mt-1">
                Escalate critical findings from the Investigations tab to send them to Builder.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {escalations
                .filter(e =>
                  (escalationFilter === 'all' || e.status === escalationFilter) &&
                  (escalationPriorityFilter === 'all' || e.suggested_priority === escalationPriorityFilter)
                )
                .map(e => (
                  <EscalationCard key={e.id} escalation={e} findings={findings} />
                ))}
            </div>
          )}
        </div>
      )}

      {/* Tab: Investigations — existing findings list */}
      {tab === 'investigations' && (
        <>
          {/* Status pills — quick switches between open / resolved etc. */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {STATUS_FILTERS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setStatus(opt.value)}
                className={`text-xs px-2.5 py-1 rounded border ${
                  status === opt.value
                    ? 'border-amber-500 bg-amber-500/10 text-amber-300'
                    : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Search + multi-filter row — refined client-side over the server fetch (investigations tab only) */}
      {tab === 'investigations' && (
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search title, observation, recommendation…"
          className="text-xs h-8 px-3 rounded border border-zinc-700 bg-zinc-900 text-zinc-100 w-72"
        />
        <select
          value={severity}
          onChange={e => setSeverity(e.target.value)}
          className="text-xs h-8 px-2 rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
        >
          <option value="all">All severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
          <option value="positive">Positive</option>
        </select>
        <select
          value={action}
          onChange={e => setAction(e.target.value)}
          className="text-xs h-8 px-2 rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
        >
          <option value="all">All actions</option>
          <option value="operator_can_act">Operator can act</option>
          <option value="escalate_to_builder">Escalate to builder</option>
          <option value="awareness">Awareness</option>
        </select>
        <select
          value={findType}
          onChange={e => setFindType(e.target.value)}
          className="text-xs h-8 px-2 rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
        >
          <option value="all">All types</option>
          <option value="performance">Performance</option>
          <option value="usage">Usage</option>
          <option value="friction">Friction</option>
          <option value="health">Health</option>
          <option value="security">Security</option>
          <option value="feature">Feature</option>
          <option value="alert">Alert</option>
          <option value="suggestion">Suggestion</option>
        </select>
        <span className="text-xs text-zinc-500 ml-auto">
          {visibleFindings.length} of {findings.length} finding{findings.length !== 1 ? 's' : ''}
          {visibleFindings.length !== findings.length ? ' (filtered)' : ''}
        </span>
      </div>
      )}

      {tab === 'investigations' && (loading ? (
        <p className="text-sm text-zinc-400">Loading…</p>
      ) : visibleFindings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-800 p-10 text-center">
          <p className="text-sm text-zinc-400">No findings to show.</p>
          <p className="text-xs text-zinc-500 mt-1">
            {findings.length === 0
              ? (status === 'open'
                  ? 'All open findings have been resolved or dismissed.'
                  : 'No scans cover this status yet.')
              : 'Try clearing filters or broadening your search.'}
          </p>
        </div>
      ) : visibleFindings.length === 1
            && visibleFindings[0].finding_type === 'health'
            && visibleFindings[0].title === 'No activity in this period' ? (
        // Quiet-period special-case — when the runner short-circuited because
        // there was no activity, render a soft empty state instead of the
        // single info card.
        <div className="rounded-lg border border-dashed border-zinc-800 p-10 text-center space-y-2">
          <p className="text-3xl">💤</p>
          <p className="text-sm text-zinc-300 font-medium">Quiet period</p>
          <p className="text-xs text-zinc-500 max-w-md mx-auto">{visibleFindings[0].observation}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleFindings.map(f => (
            <FindingCard key={f.id} finding={f} groupMap={groupMap} onAction={patchFinding} onEscalate={handleEscalateFinding} />
          ))}
        </div>
      ))}

      {/* Scan history (investigations tab only) */}
      {tab === 'investigations' && scans.length > 0 && (
        <div className="border-t border-zinc-800 pt-5 space-y-2">
          <h2 className="text-sm font-semibold text-zinc-200">Recent scans</h2>
          <ul className="divide-y divide-zinc-800 border border-zinc-800 rounded-lg">
            {scans.map(s => (
              <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                <span className="text-zinc-400 w-32">{formatDate(s.started_at)}</span>
                <span className="text-zinc-200 capitalize">{s.scan_type}</span>
                <span className={`ml-2 ${s.status === 'failed' ? 'text-red-400' : s.status === 'running' ? 'text-amber-400' : 'text-zinc-500'}`}>
                  {s.status}
                </span>
                <span className="ml-auto text-zinc-500">
                  {s.findings_count} findings · {s.critical_count} critical
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Escalation modal */}
      {escalationModalOpen && escalatingFinding && (
        <EscalationModal
          finding={escalatingFinding}
          onClose={() => { setEscalationModalOpen(false); setEscalatingFinding(null) }}
          onSubmit={submitEscalation}
          busy={escalationBusy}
        />
      )}

      {/* Respond to feedback modal */}
      {respondTo && (
        <RespondModal
          suggestion={respondTo}
          onClose={() => setRespondTo(null)}
          onSent={() => { setRespondTo(null); setToast('Response sent'); loadFeedback() }}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 px-3 py-2 rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-200">
          {toast}
        </div>
      )}
    </div>
  )
}

function FindingCard({
  finding, groupMap, onAction, onEscalate,
}: {
  finding:  SageFinding
  groupMap: Record<string, string>
  onAction: (id: string, status: SageFindingStatus, dismissedReason?: string) => Promise<void>
  onEscalate: (finding: SageFinding) => void
}) {
  const [expanded, setExpanded] = useState(finding.severity === 'critical')
  const sev = SEVERITY_STYLE[finding.severity]

  const affectedGroupNames = (finding.affected_groups ?? [])
    .map(gid => groupMap[gid] ?? gid.slice(0, 8))

  async function copyFinding() {
    const text = [
      `${sev.label} · ${ACTION_LABEL[finding.action_type]}`,
      `${finding.title}`,
      '',
      `Observation: ${finding.observation}`,
      `Interpretation: ${finding.interpretation}`,
      finding.recommendation ? `Recommendation: ${finding.recommendation}` : '',
    ].filter(Boolean).join('\n')
    try { await navigator.clipboard.writeText(text) } catch { /* ignore */ }
  }

  return (
    <div className={`rounded-lg border p-4 space-y-2 ${
      finding.status === 'dismissed' || finding.status === 'resolved'
        ? 'bg-zinc-900/30 border-zinc-800 opacity-60'
        : 'bg-zinc-900/40 border-zinc-800'
    }`}>
      <div className="flex items-start gap-3">
        <span className={`mt-1.5 h-2 w-2 rounded-full ${sev.dot}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${sev.tag}`}>
              {sev.label}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
              {ACTION_LABEL[finding.action_type]}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
              {finding.finding_type}
            </span>
            {finding.affected_count != null && finding.affected_count > 0 && (
              <span className="text-[10px] text-zinc-500">{finding.affected_count} affected</span>
            )}
            {finding.status !== 'new' && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 ml-auto">
                {finding.status}
              </span>
            )}
          </div>
          <h3 className="text-sm font-semibold text-zinc-100 mt-1.5">{finding.title}</h3>
          {/* Meta line — timestamp + scan source + affected group names. */}
          <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500 flex-wrap">
            <span>{formatDate(finding.created_at)}</span>
            <span className="text-zinc-700">·</span>
            <span className="capitalize">{finding.scan_type} scan</span>
            {affectedGroupNames.length > 0 && (
              <>
                <span className="text-zinc-700">·</span>
                <span>
                  {affectedGroupNames.slice(0, 4).join(', ')}
                  {affectedGroupNames.length > 4 ? ` +${affectedGroupNames.length - 4}` : ''}
                </span>
              </>
            )}
          </div>
        </div>
        <button
          onClick={() => setExpanded(e => !e)}
          className="text-[11px] text-zinc-500 hover:text-zinc-200"
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>

      {expanded && (
        <div className="space-y-3 pt-2 border-t border-zinc-800">
          <Section label="Observation"     text={finding.observation} />
          <Section label="Interpretation" text={finding.interpretation} />
          {finding.recommendation && (
            <Section label="Recommendation" text={finding.recommendation} />
          )}

          <div className="flex items-center gap-1.5 flex-wrap pt-1">
            {finding.status === 'new' && (
              <button
                onClick={() => void onAction(finding.id, 'acknowledged')}
                className="text-[11px] px-2 py-1 rounded border border-zinc-700 text-zinc-200 hover:bg-zinc-800"
              >Acknowledge</button>
            )}
            {finding.status !== 'acting' && finding.status !== 'resolved' && finding.status !== 'dismissed' && (
              <button
                onClick={() => void onAction(finding.id, 'acting')}
                className="text-[11px] px-2 py-1 rounded border border-zinc-700 text-zinc-200 hover:bg-zinc-800"
              >Acting</button>
            )}
            {finding.status !== 'resolved' && finding.status !== 'dismissed' && (
              <button
                onClick={() => void onAction(finding.id, 'resolved')}
                className="text-[11px] px-2 py-1 rounded border border-emerald-700 text-emerald-300 hover:bg-emerald-950/30"
              >Resolve</button>
            )}
            {finding.status !== 'dismissed' && (
              <button
                onClick={() => {
                  const reason = window.prompt('Reason for dismissing? (optional)') ?? ''
                  void onAction(finding.id, 'dismissed', reason || undefined)
                }}
                className="text-[11px] px-2 py-1 rounded border border-zinc-700 text-zinc-400 hover:bg-zinc-800"
              >Dismiss</button>
            )}
            {/* Escalate to Builder button — shown when finding is new/acknowledged and not yet escalated */}
            {(finding.status === 'new' || finding.status === 'acknowledged') && !finding.escalation_id && (
              <button
                onClick={() => onEscalate(finding)}
                className="text-[11px] px-2 py-1 rounded border border-violet-700 text-violet-300 hover:bg-violet-950/30"
              >Escalate to Builder</button>
            )}
            {finding.escalation_id && (
              <span className="text-[11px] px-2 py-1 rounded bg-violet-900/30 text-violet-400">
                Escalated
              </span>
            )}
            <button
              onClick={() => void copyFinding()}
              className="text-[11px] px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 ml-auto"
            >Copy</button>
          </div>
        </div>
      )}
    </div>
  )
}

function Section({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="text-xs text-zinc-200 whitespace-pre-wrap mt-0.5">{text}</p>
    </div>
  )
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-AU', {
    day:   '2-digit', month: 'short', year: 'numeric',
    hour:  '2-digit', minute: '2-digit',
  })
}

// ────────────────────────────────────────────────────────────────────────────
// EscalationCard — Status-return tracking UI (Phase 2)
// ────────────────────────────────────────────────────────────────────────────

function EscalationCard({
  escalation,
  findings,
}: {
  escalation: SageEscalation
  findings:   SageFinding[]
}) {
  const [expanded, setExpanded] = useState(false)

  // Find associated finding for context
  const finding = findings.find(f => f.id === escalation.finding_id)

  // Priority styling
  const priorityStyle = escalation.suggested_priority === 'critical' ? 'bg-red-500/15 text-red-300 border-red-500/30'
                       : escalation.suggested_priority === 'high'     ? 'bg-orange-500/15 text-orange-300 border-orange-500/30'
                       : escalation.suggested_priority === 'medium'   ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                       : 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'

  // Build progress from status-return
  const buildProgress = escalation.build_progress as { branch?: string; pr_url?: string; shipped?: boolean } | null

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${priorityStyle}`}>
              {escalation.suggested_priority?.toUpperCase() ?? 'MEDIUM'}
            </span>
            <StatusBadge status={escalation.status} buildProgress={buildProgress} />
            {escalation.trigger_type && (
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                {escalation.trigger_type.replace('_', ' ')}
              </span>
            )}
          </div>
          <h3 className="text-sm font-semibold text-zinc-100">{escalation.summary}</h3>
          <div className="text-[11px] text-zinc-500 flex items-center gap-2 flex-wrap">
            <span>{formatDate(escalation.created_at)}</span>
            {escalation.sent_at && (
              <>
                <span className="text-zinc-700">·</span>
                <span>Sent {formatDate(escalation.sent_at)}</span>
              </>
            )}
            {finding && (
              <>
                <span className="text-zinc-700">·</span>
                <span className="capitalize">{finding.severity} finding</span>
              </>
            )}
          </div>
        </div>
        <button
          onClick={() => setExpanded(e => !e)}
          className="text-[11px] text-zinc-500 hover:text-zinc-200"
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>

      {/* Status-return timeline (always visible) */}
      <div className="flex items-center gap-2 text-[11px] border-t border-zinc-800 pt-3">
        <TimelineStep label="Drafted" active completed />
        <div className="h-px flex-1 bg-zinc-700" />
        <TimelineStep label="Sent" active={escalation.status !== 'drafted'} completed={escalation.status !== 'drafted'} />
        <div className="h-px flex-1 bg-zinc-700" />
        <TimelineStep label="Acknowledged" active={escalation.status === 'acknowledged' || escalation.status === 'acted'} completed={escalation.status === 'acknowledged' || escalation.status === 'acted'} />
        <div className="h-px flex-1 bg-zinc-700" />
        <TimelineStep label="Acted" active={escalation.status === 'acted'} completed={escalation.status === 'acted'} />
      </div>

      {/* Build progress indicators */}
      {buildProgress && (
        <div className="flex items-center gap-3 text-xs text-zinc-300 bg-violet-950/20 border border-violet-800/30 rounded px-3 py-2">
          {buildProgress.branch && (
            <div className="flex items-center gap-1.5">
              <GitBranch className="h-3.5 w-3.5 text-violet-400" />
              <span className="font-mono text-violet-300">{buildProgress.branch}</span>
            </div>
          )}
          {buildProgress.pr_url && (
            <a
              href={buildProgress.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-violet-400 hover:text-violet-300"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              View PR
            </a>
          )}
          {buildProgress.shipped && (
            <div className="flex items-center gap-1.5 text-emerald-400">
              <Rocket className="h-3.5 w-3.5" />
              Shipped
            </div>
          )}
        </div>
      )}

      {expanded && (
        <div className="space-y-3 pt-2 border-t border-zinc-800">
          <Section label="Detail" text={escalation.detail} />
          {finding && (
            <div className="pt-2">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Original Finding</p>
              <button
                onClick={() => {
                  // Navigate to Investigations tab and highlight finding
                  window.scrollTo({ top: 0, behavior: 'smooth' })
                }}
                className="text-xs text-violet-400 hover:underline"
              >
                View in Investigations →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StatusBadge({
  status,
  buildProgress,
}: {
  status: string
  buildProgress: { shipped?: boolean } | null
}) {
  if (buildProgress?.shipped) {
    return (
      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-900/30 text-emerald-400 border border-emerald-700/30 flex items-center gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Shipped
      </span>
    )
  }

  const style = status === 'acted'        ? 'bg-blue-900/30 text-blue-400 border-blue-700/30'
              : status === 'acknowledged' ? 'bg-amber-900/30 text-amber-400 border-amber-700/30'
              : status === 'sent'         ? 'bg-sky-900/30 text-sky-400 border-sky-700/30'
              : status === 'declined'     ? 'bg-zinc-800 text-zinc-500 border-zinc-700'
              : 'bg-zinc-800 text-zinc-400 border-zinc-700'

  const icon = status === 'acted' ? <GitBranch className="h-3 w-3" />
             : status === 'acknowledged' || status === 'sent' ? <Clock className="h-3 w-3" />
             : null

  return (
    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${style} flex items-center gap-1`}>
      {icon}
      {status}
    </span>
  )
}

function TimelineStep({
  label,
  active,
  completed,
}: {
  label:     string
  active:    boolean
  completed: boolean
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className={`h-2 w-2 rounded-full ${
        completed ? 'bg-violet-500' : active ? 'bg-violet-700' : 'bg-zinc-700'
      }`} />
      <span className={`text-[10px] whitespace-nowrap ${
        completed ? 'text-violet-400' : active ? 'text-zinc-400' : 'text-zinc-600'
      }`}>
        {label}
      </span>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// EscalationModal — Escalation creation form
// ────────────────────────────────────────────────────────────────────────────

function EscalationModal({
  finding,
  onClose,
  onSubmit,
  busy,
}: {
  finding:  SageFinding
  onClose:  () => void
  onSubmit: (operatorContext: string) => void
  busy:     boolean
}) {
  const [operatorContext, setOperatorContext] = useState('')

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Escalate to Builder</h2>
            <p className="text-xs text-zinc-400 mt-1">
              Send this finding to Builder&apos;s Kaizen for code-level resolution.
            </p>
          </div>

          <div className="space-y-3 border border-zinc-800 rounded-lg p-4 bg-zinc-950/50">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">Finding</p>
              <p className="text-sm text-zinc-200 mt-1">{finding.title}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">Observation</p>
              <p className="text-xs text-zinc-300 mt-1">{finding.observation}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">Interpretation</p>
              <p className="text-xs text-zinc-300 mt-1">{finding.interpretation}</p>
            </div>
            {finding.recommendation && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-zinc-500">Recommendation</p>
                <p className="text-xs text-zinc-300 mt-1">{finding.recommendation}</p>
              </div>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-zinc-200">
              Additional context (optional)
            </label>
            <p className="text-[11px] text-zinc-500 mt-0.5 mb-2">
              Provide any extra context, specific asks, or constraints for Builder.
            </p>
            <textarea
              value={operatorContext}
              onChange={e => setOperatorContext(e.target.value)}
              placeholder="e.g. Prioritize fixing the auth flow issue before the mobile app rollout on Friday."
              rows={4}
              className="w-full px-3 py-2 rounded border border-zinc-700 bg-zinc-950 text-zinc-100 text-xs"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              disabled={busy}
              className="text-xs px-4 py-2 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={() => onSubmit(operatorContext)}
              disabled={busy}
              className="text-xs px-4 py-2 rounded bg-violet-500 text-zinc-950 font-semibold hover:bg-violet-400 disabled:opacity-50"
            >
              {busy ? 'Escalating…' : 'Escalate to Builder'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// FeedbackCard — User suggestion/feedback with Sage triage overlay
// ────────────────────────────────────────────────────────────────────────────

const STATUS_COLOUR: Record<string, string> = {
  submitted:    'bg-amber-500/15 text-amber-300 border-amber-500/30',
  triaged:      'bg-violet-500/15 text-violet-300 border-violet-500/30',
  acknowledged: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  acting:       'bg-blue-500/15 text-blue-300 border-blue-500/30',
  declined:     'bg-zinc-700 text-zinc-300 border-zinc-600',
  shipped:      'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
}

interface SageTriage {
  category?:         string
  routing?:          string
  similar_count?:    number
  existing_feature?: { exists?: boolean; explanation?: string }
  related_findings?: string[]
  disposition?:      string
  reasoning?:        string
  user_response?:    string
  raw?:              string
}

function FeedbackCard({
  suggestion, busy, onTriage, onSubmitToSage, onAck, onActing, onDecline, onShipped, onRespond,
}: {
  suggestion:     EnrichedSuggestion
  busy:           boolean
  onTriage:       () => void
  onSubmitToSage: () => void
  onAck:          () => void
  onActing:       () => void
  onDecline:      () => void
  onShipped:      () => void
  onRespond:      () => void
}) {
  const triage = (suggestion.sage_triage ?? null) as SageTriage | null
  const statusBadge = STATUS_COLOUR[suggestion.status] ?? 'bg-zinc-800 text-zinc-300 border-zinc-700'

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
      <div className="flex items-start gap-3 flex-wrap">
        <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${statusBadge}`}>
          {suggestion.status}
        </span>
        {suggestion.category && (
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">
            {suggestion.category.replace(/_/g, ' ')}
          </span>
        )}
        <span className="text-[11px] text-zinc-400 ml-auto">
          {suggestion.submitter_email ?? 'unknown user'}
          {suggestion.group_name && ` · ${suggestion.group_name}`}
          {' · '}{relativeDate(suggestion.created_at)}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
        <FeedbackBlock label="Trying to"  text={suggestion.what_trying} />
        <FeedbackBlock label="Happened"   text={suggestion.what_happened} />
        <FeedbackBlock label="Wanted"     text={suggestion.what_wanted} />
      </div>

      {triage && (
        <div className="rounded-md bg-zinc-950/50 border border-zinc-800 p-3 space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500">Sage triage</p>
          {triage.disposition && (
            <p className="text-xs text-zinc-300">
              <span className="font-medium text-zinc-100">Disposition: </span>
              {triage.disposition.replace(/_/g, ' ')}
            </p>
          )}
          {triage.reasoning && (
            <p className="text-xs text-zinc-300 whitespace-pre-wrap">{triage.reasoning}</p>
          )}
          {triage.user_response && (
            <div className="mt-1.5 pt-1.5 border-t border-zinc-800">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">Suggested user response</p>
              <p className="text-xs text-zinc-200 whitespace-pre-wrap">{triage.user_response}</p>
            </div>
          )}
          {triage.raw && (
            <p className="text-[11px] text-zinc-500 whitespace-pre-wrap">Raw: {triage.raw.slice(0, 600)}</p>
          )}
        </div>
      )}

      {suggestion.operator_note && (
        <p className="text-xs text-zinc-400 italic">Note: {suggestion.operator_note}</p>
      )}

      <div className="flex items-center gap-1.5 flex-wrap pt-1">
        {!triage && (
          <button
            onClick={onTriage}
            disabled={busy}
            className="text-[11px] px-2 py-1 rounded border border-amber-700 text-amber-300 hover:bg-amber-950/30 disabled:opacity-60"
          >Triage with Sage</button>
        )}
        <button
          onClick={onSubmitToSage}
          disabled={busy}
          title="Run a focused Sage scan using this feedback as the brief"
          className="text-[11px] px-2 py-1 rounded border border-violet-700 text-violet-300 hover:bg-violet-950/30 disabled:opacity-60"
        >Submit to Sage</button>
        {suggestion.status !== 'acknowledged' && suggestion.status !== 'shipped' && suggestion.status !== 'declined' && (
          <button
            onClick={onAck}
            disabled={busy}
            className="text-[11px] px-2 py-1 rounded border border-zinc-700 text-zinc-200 hover:bg-zinc-800 disabled:opacity-60"
          >Acknowledge</button>
        )}
        {suggestion.status !== 'acting' && suggestion.status !== 'shipped' && suggestion.status !== 'declined' && (
          <button
            onClick={onActing}
            disabled={busy}
            className="text-[11px] px-2 py-1 rounded border border-zinc-700 text-zinc-200 hover:bg-zinc-800 disabled:opacity-60"
          >Acting</button>
        )}
        {suggestion.status !== 'shipped' && (
          <button
            onClick={onShipped}
            disabled={busy}
            className="text-[11px] px-2 py-1 rounded border border-emerald-700 text-emerald-300 hover:bg-emerald-950/30 disabled:opacity-60"
          >Shipped</button>
        )}
        {suggestion.status !== 'declined' && (
          <button
            onClick={onDecline}
            disabled={busy}
            className="text-[11px] px-2 py-1 rounded border border-zinc-700 text-zinc-400 hover:bg-zinc-800 disabled:opacity-60"
          >Decline</button>
        )}
        <button
          onClick={onRespond}
          disabled={busy}
          className="text-[11px] px-2 py-1 rounded border border-zinc-700 text-zinc-200 hover:bg-zinc-800 disabled:opacity-60 ml-auto"
        >Send response</button>
      </div>
    </div>
  )
}

function FeedbackBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="text-zinc-200 whitespace-pre-wrap">{text}</p>
    </div>
  )
}

function RespondModal({
  suggestion, onClose, onSent,
}: {
  suggestion: EnrichedSuggestion
  onClose:    () => void
  onSent:     () => void
}) {
  const triage = (suggestion.sage_triage ?? null) as SageTriage | null
  const draft  = triage?.user_response ?? ''
  const [message, setMessage] = useState(draft)
  const [status,  setStatus]  = useState<'acknowledged' | 'declined' | 'shipped'>('acknowledged')
  const [busy,    setBusy]    = useState(false)
  const [err,     setErr]     = useState<string | null>(null)

  async function send() {
    if (!message.trim()) return
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch(`/api/admin/suggestions/${suggestion.id}/notify`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message: message.trim(), status }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Send failed')
      onSent()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Send failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-lg overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-100">Respond to feedback</h3>
          <button onClick={onClose} className="text-xs text-zinc-400 hover:text-zinc-200">✕</button>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-xs text-zinc-400">
            Sending to <span className="text-zinc-200">{suggestion.submitter_email ?? 'submitter'}</span>
          </p>
          <textarea
            value={message}
            onChange={e => setMessage(e.target.value)}
            rows={5}
            className="w-full px-3 py-2 rounded border border-zinc-700 bg-zinc-950 text-zinc-100 text-xs"
            placeholder="Your response — concise and warm."
          />
          <label className="text-xs text-zinc-300 flex items-center gap-2">
            Mark as:
            <select
              value={status}
              onChange={e => setStatus(e.target.value as typeof status)}
              className="h-7 px-2 rounded border border-zinc-700 bg-zinc-950 text-zinc-100 text-xs"
            >
              <option value="acknowledged">Acknowledged</option>
              <option value="declined">Declined</option>
              <option value="shipped">Shipped</option>
            </select>
          </label>
          {err && <p className="text-xs text-red-400">{err}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-800">
          <button
            onClick={onClose}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-200 hover:bg-zinc-800"
          >Cancel</button>
          <button
            onClick={send}
            disabled={busy || !message.trim()}
            className="text-xs px-3 py-1.5 rounded bg-amber-500 text-zinc-900 font-semibold hover:bg-amber-400 disabled:opacity-60"
          >{busy ? 'Sending…' : 'Send response'}</button>
        </div>
      </div>
    </div>
  )
}

function relativeDate(iso: string): string {
  const ms   = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 1)    return 'just now'
  if (mins < 60)   return `${mins}m ago`
  const hrs  = Math.floor(mins / 60)
  if (hrs < 24)    return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7)    return `${days}d ago`
  return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' })
}
