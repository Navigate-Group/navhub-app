'use client'

import { useEffect, useState } from 'react'
import type { UserSuggestion } from '@/lib/types'

type Filter = 'open' | 'submitted' | 'triaged' | 'acknowledged' | 'declined' | 'shipped' | 'all'

interface EnrichedSuggestion extends UserSuggestion {
  submitter_email: string | null
  group_name:      string | null
  type: 'feedback' | 'support_request' | 'feature_suggestion'
}

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'open',         label: 'Open'         },
  { value: 'submitted',    label: 'Submitted'    },
  { value: 'triaged',      label: 'Triaged'      },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'declined',     label: 'Declined'     },
  { value: 'shipped',      label: 'Shipped'      },
  { value: 'all',          label: 'All'          },
]

const STATUS_COLOUR: Record<string, string> = {
  submitted:    'bg-amber-500/15 text-amber-300 border-amber-500/30',
  triaged:      'bg-violet-500/15 text-violet-300 border-violet-500/30',
  acknowledged: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  acting:       'bg-blue-500/15 text-blue-300 border-blue-500/30',
  declined:     'bg-zinc-700 text-zinc-300 border-zinc-600',
  shipped:      'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
}

const TYPE_LABEL: Record<string, string> = {
  feedback:            'User Feedback',
  support_request:     'Support Request',
  feature_suggestion:  'Feature Suggestion',
}

const TYPE_COLOUR: Record<string, string> = {
  feedback:            'bg-blue-500/15 text-blue-300 border-blue-500/30',
  support_request:     'bg-rose-500/15 text-rose-300 border-rose-500/30',
  feature_suggestion:  'bg-purple-500/15 text-purple-300 border-purple-500/30',
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

export default function AdminSuggestionsPage() {
  const [suggestions, setSuggestions] = useState<EnrichedSuggestion[]>([])
  const [loading,     setLoading]     = useState(true)
  const [filter,      setFilter]      = useState<Filter>('open')
  const [busyIds,     setBusyIds]     = useState<Set<string>>(new Set())
  const [toast,       setToast]       = useState<string | null>(null)
  const [respondTo,   setRespondTo]   = useState<EnrichedSuggestion | null>(null)

  function loadAll() {
    setLoading(true)
    const params = new URLSearchParams()
    if (filter === 'open')      params.set('status', 'submitted,triaged,acknowledged,acting')
    if (filter === 'submitted') params.set('status', 'submitted')
    if (filter === 'triaged')   params.set('status', 'triaged')
    if (filter === 'acknowledged') params.set('status', 'acknowledged,acting')
    if (filter === 'declined')  params.set('status', 'declined')
    if (filter === 'shipped')   params.set('status', 'shipped')
    if (filter === 'all')       params.set('status', 'submitted,triaged,acknowledged,acting,declined,shipped')

    fetch(`/api/admin/suggestions?${params.toString()}`)
      .then(r => r.json())
      .then((j: { data?: EnrichedSuggestion[] }) => setSuggestions(j.data ?? []))
      .finally(() => setLoading(false))
  }
  useEffect(() => { loadAll() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(t)
  }, [toast])

  function setBusy(id: string, on: boolean) {
    setBusyIds(prev => {
      const next = new Set(prev)
      if (on) next.add(id); else next.delete(id)
      return next
    })
  }

  async function patchStatus(id: string, status: string) {
    setBusy(id, true)
    try {
      const res = await fetch(`/api/admin/suggestions/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ status }),
      })
      if (!res.ok) throw new Error('Update failed')
      setToast(`Marked ${status}`)
      loadAll()
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
      loadAll()
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Triage failed')
    } finally {
      setBusy(id, false)
    }
  }

  // Launch a focused Sage scan whose entire brief is this user's feedback.
  // Useful when triage isn't enough — e.g. the user is reporting a symptom
  // ("Add Documents button greyed out") and we want Sage to investigate
  // permissions / recent errors / agent config for that specific user + group.
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
      // Roll the suggestion to triaged so it doesn't sit in the inbox.
      await patchStatus(s.id, 'triaged')
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Scan failed')
    } finally {
      setBusy(s.id, false)
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">User Feedback</h1>
        <p className="text-xs text-zinc-400 mt-0.5">
          User feedback, support requests, and feature suggestions from across all groups. Sage triages new submissions on demand.
        </p>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {FILTERS.map(f => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`text-xs px-2.5 py-1 rounded border ${
              filter === f.value
                ? 'border-amber-500 bg-amber-500/10 text-amber-300'
                : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-zinc-400">Loading…</p>
      ) : suggestions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-800 p-10 text-center">
          <p className="text-sm text-zinc-400">No suggestions in this view.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {suggestions.map(s => (
            <SuggestionCard
              key={s.id}
              suggestion={s}
              busy={busyIds.has(s.id)}
              onTriage={() => triageWithSage(s.id)}
              onSubmitToSage={() => submitToSage(s)}
              onAck={() => patchStatus(s.id, 'acknowledged')}
              onActing={() => patchStatus(s.id, 'acting')}
              onDecline={() => patchStatus(s.id, 'declined')}
              onShipped={() => patchStatus(s.id, 'shipped')}
              onRespond={() => setRespondTo(s)}
            />
          ))}
        </div>
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 px-3 py-2 rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-200">
          {toast}
        </div>
      )}

      {respondTo && (
        <RespondModal
          suggestion={respondTo}
          onClose={() => setRespondTo(null)}
          onSent={() => { setRespondTo(null); setToast('Response sent'); loadAll() }}
        />
      )}
    </div>
  )
}

function SuggestionCard({
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
  const typeBadge = TYPE_COLOUR[suggestion.type] ?? 'bg-zinc-800 text-zinc-300 border-zinc-700'
  const typeLabel = TYPE_LABEL[suggestion.type] ?? suggestion.type

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
      <div className="flex items-start gap-3 flex-wrap">
        <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${typeBadge}`}>
          {typeLabel}
        </span>
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
        <Block label="Trying to"  text={suggestion.what_trying} />
        <Block label="Happened"   text={suggestion.what_happened} />
        <Block label="Wanted"     text={suggestion.what_wanted} />
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

function Block({ label, text }: { label: string; text: string }) {
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
