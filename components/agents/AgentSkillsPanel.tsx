'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { Sparkles, Plus, Trash2, Loader2, X, Pencil } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import type { Skill } from '@/lib/types'

interface Assignment {
  id:         string
  sort_order: number
  skill_id:   string
  skills:     Skill | null
}

interface SkillsResponse {
  data?: {
    assigned:           Assignment[]
    own:                Skill[]
    inherited_platform: Skill[]
    inherited_group:    Array<{ skills: Skill | null }>
  }
  error?: string
}

const ALL_TOOL_OPTIONS = [
  'read_financials','read_companies','web_search',
  'list_documents','read_document','create_document','update_document',
  'list_report_templates','read_report_template','render_report','generate_report','analyse_document',
  'read_attachment','send_email','send_slack',
  'read_marketing_data','summarise_marketing',
]

interface Draft {
  name:           string
  description:    string
  instructions:   string
  knowledge_text: string
  examples:       string
  category:       string
  tool_grants:    string[]
}

const emptyDraft = (): Draft => ({
  name: '', description: '', instructions: '',
  knowledge_text: '', examples: '', category: '', tool_grants: [],
})

interface AgentSkillsPanelProps {
  agentId: string | null
  mode:    'create' | 'edit'
}

export default function AgentSkillsPanel({ agentId, mode }: AgentSkillsPanelProps) {
  const [data,    setData]    = useState<SkillsResponse['data'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [picking, setPicking] = useState(false)
  const [editing, setEditing] = useState<Draft | null>(null)
  const [busy,    setBusy]    = useState(false)
  const [toast,   setToast]   = useState<string | null>(null)

  const loadAll = useCallback(() => {
    if (!agentId) { setLoading(false); return }
    setLoading(true)
    fetch(`/api/agents/${agentId}/skills`)
      .then(r => r.json())
      .then((j: SkillsResponse) => setData(j.data ?? null))
      .finally(() => setLoading(false))
  }, [agentId])
  useEffect(() => { loadAll() }, [loadAll])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(t)
  }, [toast])

  const assigned        = useMemo(() => data?.assigned ?? [], [data?.assigned])
  const inheritPlatform = useMemo(() => data?.inherited_platform ?? [], [data?.inherited_platform])
  const inheritGroup    = useMemo(() => (data?.inherited_group ?? []).map(g => g.skills).filter(Boolean) as Skill[], [data?.inherited_group])

  const assignableSkills = useMemo(() => {
    if (!data) return [] as Skill[]
    const assignedIds = new Set(assigned.map(a => a.skill_id))
    // The picker offers: published platform skills + group/agent skills owned
    // by the same group, minus anything already assigned.
    return [...inheritPlatform, ...(data.own ?? [])]
      .filter(s => !assignedIds.has(s.id))
  }, [data, assigned, inheritPlatform])

  if (mode === 'create') {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Save the agent first, then you can assign skills.
        </CardContent>
      </Card>
    )
  }

  async function assignExisting(skillId: string) {
    if (!agentId) return
    setBusy(true)
    try {
      const res = await fetch(`/api/agents/${agentId}/skills`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'assign', skill_id: skillId }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? 'Assign failed')
      }
      setToast('Skill added')
      setPicking(false)
      loadAll()
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Assign failed')
    } finally {
      setBusy(false)
    }
  }

  async function createAgentSkill(d: Draft) {
    if (!agentId) return
    setBusy(true)
    try {
      const res = await fetch(`/api/agents/${agentId}/skills`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          action:         'create_agent',
          name:           d.name,
          description:    d.description,
          instructions:   d.instructions,
          knowledge_text: d.knowledge_text,
          examples:       d.examples,
          category:       d.category,
          tool_grants:    d.tool_grants,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? 'Create failed')
      }
      setToast('Skill created')
      setEditing(null)
      loadAll()
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setBusy(false)
    }
  }

  async function removeAssignment(a: Assignment) {
    if (!agentId) return
    if (!confirm(`Remove "${a.skills?.name}" from this agent?`)) return
    await fetch(`/api/agents/${agentId}/skills?assignment_id=${a.id}`, { method: 'DELETE' })
    loadAll()
  }

  return (
    <div className="space-y-4">
      {/* Inherited skills — context only, read-only */}
      {(inheritPlatform.length > 0 || inheritGroup.length > 0) && (
        <Card>
          <CardContent className="pt-5 space-y-2">
            <p className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
              Auto-applied skills
            </p>
            <p className="text-xs text-muted-foreground">
              These skills apply to every agent in your group automatically. Manage them in
              Settings → Agents → Group Skills (or, for platform skills, ask your super admin).
            </p>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {inheritPlatform.map(s => (
                <span key={s.id} className="text-[11px] px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
                  Platform · {s.name}
                </span>
              ))}
              {inheritGroup.map(s => (
                <span key={s.id} className="text-[11px] px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                  Group · {s.name}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Agent-specific skills */}
      <Card>
        <CardContent className="pt-5 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <p className="text-sm font-semibold text-foreground">Agent skills</p>
              <p className="text-xs text-muted-foreground">
                Specialised expertise for this agent only — applied on top of platform and group skills.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setPicking(true)}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add Skill
              </Button>
              <Button size="sm" onClick={() => setEditing(emptyDraft())}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Create Skill
              </Button>
            </div>
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : assigned.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              No agent-specific skills yet. Inherited skills above still apply.
            </p>
          ) : (
            <ul className="divide-y border rounded-md">
              {assigned.map(a => {
                const tier = a.skills?.tier ?? 'agent'
                return (
                  <li key={a.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{a.skills?.name ?? '(missing)'}</p>
                      <p className="text-xs text-muted-foreground truncate">{a.skills?.description}</p>
                    </div>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground capitalize">
                      {tier}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs px-2 text-muted-foreground hover:text-destructive"
                      onClick={() => removeAssignment(a)}
                    >
                      <Trash2 className="h-3 w-3 mr-1" /> Remove
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}

          {toast && <p className="text-xs text-muted-foreground">{toast}</p>}
        </CardContent>
      </Card>

      {/* Picker */}
      {picking && (
        <Picker
          options={assignableSkills}
          busy={busy}
          onPick={assignExisting}
          onClose={() => setPicking(false)}
        />
      )}

      {/* Editor */}
      {editing && (
        <Editor
          draft={editing}
          onChange={setEditing}
          busy={busy}
          onSave={() => createAgentSkill(editing)}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function Picker({
  options, busy, onPick, onClose,
}: {
  options: Skill[]
  busy:    boolean
  onPick:  (id: string) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const list = options.filter(s => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return s.name.toLowerCase().includes(q) || (s.category ?? '').toLowerCase().includes(q)
  })
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-background border rounded-lg w-full max-w-lg max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 bg-background border-b px-4 py-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Add Skill to Agent</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search skills…"
            className="w-full h-9 px-3 rounded border border-input bg-background text-sm"
          />
          {list.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No additional skills available to assign.</p>
          ) : (
            <ul className="divide-y border rounded">
              {list.map(s => (
                <li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{s.name}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {s.tier === 'platform' ? 'Platform' : s.tier === 'group' ? 'Group' : 'Agent'} · {s.description}
                    </p>
                  </div>
                  <Button size="sm" disabled={busy} onClick={() => onPick(s.id)}>
                    {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Add'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function Editor({
  draft, onChange, busy, onSave, onCancel,
}: {
  draft:    Draft
  onChange: (d: Draft) => void
  busy:     boolean
  onSave:   () => void
  onCancel: () => void
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch })
  const toggleTool = (t: string) => {
    set({ tool_grants: draft.tool_grants.includes(t) ? draft.tool_grants.filter(x => x !== t) : [...draft.tool_grants, t] })
  }
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-background border rounded-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 bg-background border-b px-4 py-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold flex items-center gap-1.5"><Pencil className="h-3.5 w-3.5" /> Create Agent Skill</h3>
          <button onClick={onCancel} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-4 space-y-3 text-sm">
          <Field label="Name *">
            <input value={draft.name} onChange={e => set({ name: e.target.value })} className="w-full h-9 px-3 rounded border border-input bg-background" />
          </Field>
          <Field label="Description *">
            <textarea value={draft.description} onChange={e => set({ description: e.target.value })} rows={2} className="w-full px-3 py-2 rounded border border-input bg-background" />
          </Field>
          <Field label="Instructions *">
            <textarea value={draft.instructions} onChange={e => set({ instructions: e.target.value })} rows={6} className="w-full px-3 py-2 rounded border border-input bg-background font-mono text-xs" />
          </Field>
          <Field label="Knowledge (optional)">
            <textarea value={draft.knowledge_text} onChange={e => set({ knowledge_text: e.target.value })} rows={3} className="w-full px-3 py-2 rounded border border-input bg-background" />
          </Field>
          <Field label="Examples (optional)">
            <textarea value={draft.examples} onChange={e => set({ examples: e.target.value })} rows={3} className="w-full px-3 py-2 rounded border border-input bg-background" />
          </Field>
          <Field label="Tool Grants">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 text-xs">
              {ALL_TOOL_OPTIONS.map(t => (
                <label key={t} className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={draft.tool_grants.includes(t)} onChange={() => toggleTool(t)} className="rounded border-input" />
                  <span className="font-mono">{t}</span>
                </label>
              ))}
            </div>
          </Field>
        </div>
        <div className="sticky bottom-0 bg-background border-t px-4 py-3 flex items-center justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={onSave} disabled={busy || !draft.name || !draft.description || !draft.instructions}>
            {busy && <Loader2 className="h-3 w-3 animate-spin mr-1" />}Create &amp; Assign
          </Button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}
