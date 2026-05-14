'use client'

import { useState, useEffect, useMemo } from 'react'
import type {
  SageFinding, SageScan, SageSeverity, SageFindingStatus, SageActionType,
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

export default function AdminSagePage() {
  const [findings,  setFindings]  = useState<SageFinding[]>([])
  const [scans,     setScans]     = useState<SageScan[]>([])
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

  function loadAll() {
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
    ])
      .then(([fJson, sJson]) => {
        setFindings((fJson.data ?? []) as SageFinding[])
        setScans((sJson.data ?? []) as SageScan[])
      })
      .finally(() => setLoading(false))
  }
  useEffect(() => { loadAll() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [status])

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

      {/* Search + multi-filter row — refined client-side over the server fetch */}
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

      {loading ? (
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
      ) : (
        <div className="space-y-3">
          {visibleFindings.map(f => (
            <FindingCard key={f.id} finding={f} groupMap={groupMap} onAction={patchFinding} />
          ))}
        </div>
      )}

      {/* Scan history */}
      {scans.length > 0 && (
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

      {toast && (
        <div className="fixed bottom-4 right-4 px-3 py-2 rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-200">
          {toast}
        </div>
      )}
    </div>
  )
}

function FindingCard({
  finding, groupMap, onAction,
}: {
  finding:  SageFinding
  groupMap: Record<string, string>
  onAction: (id: string, status: SageFindingStatus, dismissedReason?: string) => Promise<void>
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
