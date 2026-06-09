'use client'

import { useState, useEffect, useCallback } from 'react'
import { Loader2, Save, FileText, Upload, X, Sparkles, Settings as SettingsIcon, Building2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input }  from '@/components/ui/input'
import { Label }  from '@/components/ui/label'
import { Badge }  from '@/components/ui/badge'
import { cn }     from '@/lib/utils'
import { AssistantConfig, KnowledgeDoc } from '@/lib/types'

interface GroupRow {
  id:                string
  name:              string
  has_custom_config: boolean
}

const EMPTY_CONFIG: AssistantConfig = {
  persona_name:         'NavHub Assistant',
  persona_tone:         'professional',
  persona_instructions: null,
  scope_text:           null,
  knowledge_text:       null,
  restrictions:         null,
}

// ─── Config Form (shared between Platform and Group tabs) ───────────────────

function ConfigForm({
  config, knowledgeDocs, onChange, onSave, onUploadFile, onRemoveDoc, saving, savedFlash, scopeLabel,
}: {
  config:        AssistantConfig
  knowledgeDocs: KnowledgeDoc[]
  onChange:      (next: AssistantConfig) => void
  onSave:        () => void
  onUploadFile:  (file: File) => Promise<void>
  onRemoveDoc:   (id: string) => Promise<void>
  saving:        boolean
  savedFlash:    boolean
  scopeLabel:    string  // e.g. "platform" or "group: Acme"
}) {
  const [uploading, setUploading] = useState(false)

  function field<K extends keyof AssistantConfig>(key: K, value: AssistantConfig[K]) {
    onChange({ ...config, [key]: value })
  }

  async function handleUpload(file: File) {
    setUploading(true)
    try { await onUploadFile(file) }
    finally { setUploading(false) }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-md border border-zinc-700 bg-zinc-900 p-4 text-xs text-zinc-400">
        Configuring <span className="text-zinc-200 font-medium">{scopeLabel}</span>.
        Group-level fields override platform-level fields where set.
      </div>

      <div className="space-y-1.5">
        <Label className="text-zinc-300">Persona Name</Label>
        <Input
          value={config.persona_name}
          onChange={e => field('persona_name', e.target.value)}
          placeholder="NavHub Assistant"
          className="bg-zinc-900 border-zinc-700 text-zinc-100"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-zinc-300">Persona Instructions</Label>
        <textarea
          value={config.persona_instructions ?? ''}
          onChange={e => field('persona_instructions', e.target.value || null)}
          rows={5}
          placeholder='Describe how the assistant should behave and interact with users. e.g. "Be concise and direct. Always suggest the most relevant NavHub feature. When unsure, ask one focused question."'
          className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 text-zinc-100 p-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
        />
        <p className="text-xs text-zinc-500">
          Injected into the system prompt under <span className="font-mono text-zinc-300">## How to interact</span>. Group-level overrides platform-level.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-zinc-300">Additional Knowledge</Label>
        <textarea
          value={config.knowledge_text ?? ''}
          onChange={e => field('knowledge_text', e.target.value || null)}
          rows={6}
          placeholder="Free text — product knowledge, feature descriptions, internal guidelines, terminology…"
          className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 text-zinc-100 p-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-zinc-300">Scope <span className="text-zinc-500 font-normal">(optional override)</span></Label>
        <textarea
          value={config.scope_text ?? ''}
          onChange={e => field('scope_text', e.target.value || null)}
          rows={3}
          placeholder="Leave blank to use the default broad scope. Set to narrow what the assistant focuses on for this group."
          className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 text-zinc-100 p-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-zinc-300">Restrictions <span className="text-zinc-500 font-normal">(optional)</span></Label>
        <textarea
          value={config.restrictions ?? ''}
          onChange={e => field('restrictions', e.target.value || null)}
          rows={3}
          placeholder="What the assistant should NOT do. E.g. 'Do not provide tax advice. Do not commit to deadlines.'"
          className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 text-zinc-100 p-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
        />
      </div>

      <div className="flex items-center justify-end gap-2">
        {savedFlash && <span className="text-xs text-green-400">Saved ✓</span>}
        <Button onClick={onSave} disabled={saving} size="sm">
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Save className="h-4 w-4 mr-1.5" />}
          Save Configuration
        </Button>
      </div>

      {/* Knowledge Documents */}
      <div className="space-y-2 border-t border-zinc-800 pt-5">
        <div className="flex items-center justify-between">
          <Label className="text-zinc-300">Reference Documents</Label>
          <Button
            size="sm" variant="outline"
            className="h-7 gap-1.5 text-xs bg-zinc-900 border-zinc-700 text-zinc-200 hover:bg-zinc-800"
            disabled={uploading}
            onClick={() => {
              const i = document.createElement('input')
              i.type = 'file'
              i.accept = '.pdf,.docx,.doc,.txt,.md,.csv,.xlsx,.xls,.png,.jpg,.jpeg'
              i.onchange = () => { if (i.files?.[0]) void handleUpload(i.files[0]) }
              i.click()
            }}
          >
            <Upload className="h-3.5 w-3.5" /> {uploading ? 'Uploading…' : 'Upload File'}
          </Button>
        </div>

        {knowledgeDocs.length === 0 ? (
          <p className="text-xs text-zinc-500 py-2">No reference documents.</p>
        ) : (
          <div className="divide-y divide-zinc-800 rounded-md border border-zinc-800 overflow-hidden">
            {knowledgeDocs.map(d => (
              <div key={d.id} className="flex items-center gap-3 px-3 py-2 bg-zinc-900">
                <FileText className="h-4 w-4 text-zinc-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-100 truncate">{d.document_title ?? d.file_name}</p>
                  <Badge variant="outline" className="text-[9px] px-1 py-0 border-zinc-700 text-zinc-400">
                    {d.document_id ? 'Linked' : 'Uploaded'}
                  </Badge>
                </div>
                <button
                  onClick={() => void onRemoveDoc(d.id)}
                  className="text-zinc-500 hover:text-red-400 shrink-0"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminAssistantPage() {
  const [tab, setTab] = useState<'platform' | 'groups'>('platform')

  // Platform tab state
  const [platformCfg,    setPlatformCfg]    = useState<AssistantConfig>(EMPTY_CONFIG)
  const [platformDocs,   setPlatformDocs]   = useState<KnowledgeDoc[]>([])
  const [platformLoading, setPlatformLoading] = useState(true)
  const [platformSaving, setPlatformSaving]  = useState(false)
  const [platformSaved,  setPlatformSaved]   = useState(false)

  // Groups tab state
  const [groups,        setGroups]        = useState<GroupRow[]>([])
  const [groupsLoading, setGroupsLoading] = useState(true)
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)
  const [groupCfg,      setGroupCfg]      = useState<AssistantConfig>(EMPTY_CONFIG)
  const [groupDocs,     setGroupDocs]     = useState<KnowledgeDoc[]>([])
  const [groupSaving,   setGroupSaving]   = useState(false)
  const [groupSaved,    setGroupSaved]    = useState(false)

  // ── Loaders ────────────────────────────────────────────────────────────────

  const loadPlatform = useCallback(async () => {
    setPlatformLoading(true)
    try {
      const [cfgRes, docsRes] = await Promise.all([
        fetch('/api/admin/assistant-config'),
        fetch('/api/admin/assistant-config/documents'),
      ])
      const cfgJson  = await cfgRes.json()  as { data?: AssistantConfig }
      const docsJson = await docsRes.json() as { data?: KnowledgeDoc[] }
      setPlatformCfg({ ...EMPTY_CONFIG, ...(cfgJson.data ?? {}) })
      setPlatformDocs(docsJson.data ?? [])
    } finally {
      setPlatformLoading(false)
    }
  }, [])

  const loadGroups = useCallback(async () => {
    setGroupsLoading(true)
    try {
      const res  = await fetch('/api/admin/groups')
      const json = await res.json() as { data?: Array<{ id: string; name: string }> }
      const list = json.data ?? []

      // Probe per-group config existence in parallel
      const probes = await Promise.all(list.map(g =>
        fetch(`/api/admin/assistant-config/groups/${g.id}`)
          .then(r => r.json() as Promise<{ data: AssistantConfig | null }>)
          .then(j => ({ id: g.id, has: !!j.data }))
          .catch(() => ({ id: g.id, has: false }))
      ))
      const hasMap = new Map(probes.map(p => [p.id, p.has]))

      setGroups(list.map(g => ({
        id:                g.id,
        name:              g.name,
        has_custom_config: hasMap.get(g.id) ?? false,
      })))
    } finally {
      setGroupsLoading(false)
    }
  }, [])

  const loadGroupConfig = useCallback(async (groupId: string) => {
    const [cfgRes, docsRes] = await Promise.all([
      fetch(`/api/admin/assistant-config/groups/${groupId}`),
      fetch(`/api/admin/assistant-config/documents?group_id=${encodeURIComponent(groupId)}`),
    ])
    const cfgJson  = await cfgRes.json()  as { data?: AssistantConfig }
    const docsJson = await docsRes.json() as { data?: KnowledgeDoc[] }
    setGroupCfg({ ...EMPTY_CONFIG, ...(cfgJson.data ?? {}) })
    setGroupDocs(docsJson.data ?? [])
  }, [])

  useEffect(() => { void loadPlatform() }, [loadPlatform])
  useEffect(() => { if (tab === 'groups') void loadGroups() }, [tab, loadGroups])
  useEffect(() => { if (activeGroupId) void loadGroupConfig(activeGroupId) }, [activeGroupId, loadGroupConfig])

  // ── Handlers ───────────────────────────────────────────────────────────────

  async function savePlatform() {
    setPlatformSaving(true)
    try {
      await fetch('/api/admin/assistant-config', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(platformCfg),
      })
      setPlatformSaved(true)
      setTimeout(() => setPlatformSaved(false), 2000)
    } finally { setPlatformSaving(false) }
  }

  async function saveGroup() {
    if (!activeGroupId) return
    setGroupSaving(true)
    try {
      await fetch(`/api/admin/assistant-config/groups/${activeGroupId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(groupCfg),
      })
      setGroupSaved(true)
      setTimeout(() => setGroupSaved(false), 2000)
      // Refresh "has_custom_config" flag in the table
      void loadGroups()
    } finally { setGroupSaving(false) }
  }

  async function uploadPlatformFile(file: File) {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch('/api/admin/assistant-config/documents', { method: 'POST', body: fd })
    if (res.ok) {
      const json = await res.json() as { data: KnowledgeDoc }
      setPlatformDocs(prev => [json.data, ...prev])
    }
  }

  async function uploadGroupFile(file: File) {
    if (!activeGroupId) return
    const fd = new FormData()
    fd.append('file', file)
    fd.append('group_id', activeGroupId)
    const res = await fetch('/api/admin/assistant-config/documents', { method: 'POST', body: fd })
    if (res.ok) {
      const json = await res.json() as { data: KnowledgeDoc }
      setGroupDocs(prev => [json.data, ...prev])
    }
  }

  async function removeDoc(id: string, scope: 'platform' | 'group') {
    await fetch(`/api/admin/assistant-config/documents/${id}`, { method: 'DELETE' })
    if (scope === 'platform') setPlatformDocs(prev => prev.filter(d => d.id !== id))
    else                       setGroupDocs(prev => prev.filter(d => d.id !== id))
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-3xl mx-auto px-6 py-6 space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100 flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-amber-400" /> NavHub Assistant
        </h1>
        <p className="text-sm text-zinc-400 mt-1">
          Configure the floating chat assistant. Platform settings apply to all groups
          unless overridden by a group-level configuration.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-zinc-800">
        <button
          onClick={() => setTab('platform')}
          className={cn(
            'px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2 flex items-center gap-1.5',
            tab === 'platform'
              ? 'border-amber-400 text-zinc-100'
              : 'border-transparent text-zinc-500 hover:text-zinc-300',
          )}
        >
          <SettingsIcon className="h-3.5 w-3.5" /> Platform Config
        </button>
        <button
          onClick={() => setTab('groups')}
          className={cn(
            'px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2 flex items-center gap-1.5',
            tab === 'groups'
              ? 'border-amber-400 text-zinc-100'
              : 'border-transparent text-zinc-500 hover:text-zinc-300',
          )}
        >
          <Building2 className="h-3.5 w-3.5" /> Group Configs
        </button>
      </div>

      {/* Platform tab */}
      {tab === 'platform' && (
        platformLoading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-zinc-500" /></div>
        ) : (
          <ConfigForm
            config={platformCfg}
            knowledgeDocs={platformDocs}
            onChange={setPlatformCfg}
            onSave={() => void savePlatform()}
            onUploadFile={uploadPlatformFile}
            onRemoveDoc={async (id) => { await removeDoc(id, 'platform') }}
            saving={platformSaving}
            savedFlash={platformSaved}
            scopeLabel="platform-level (applies to all groups)"
          />
        )
      )}

      {/* Groups tab */}
      {tab === 'groups' && (
        groupsLoading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-zinc-500" /></div>
        ) : (
          <div className="space-y-5">
            {/* Groups table */}
            <div className="rounded-md border border-zinc-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-zinc-900">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-zinc-400">Group</th>
                    <th className="text-left px-3 py-2 font-medium text-zinc-400">Custom Config</th>
                    <th className="text-right px-3 py-2 font-medium text-zinc-400">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800 bg-zinc-950">
                  {groups.map(g => (
                    <tr key={g.id}>
                      <td className="px-3 py-2 text-zinc-200">{g.name}</td>
                      <td className="px-3 py-2">
                        {g.has_custom_config
                          ? <Badge variant="secondary" className="text-[10px]">Custom</Badge>
                          : <span className="text-xs text-zinc-500">Inherits platform default</span>}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          size="sm" variant={activeGroupId === g.id ? 'default' : 'outline'}
                          className={cn(
                            'h-7 text-xs',
                            activeGroupId !== g.id && 'bg-zinc-900 border-zinc-700 text-zinc-200 hover:bg-zinc-800',
                          )}
                          onClick={() => setActiveGroupId(g.id === activeGroupId ? null : g.id)}
                        >
                          {activeGroupId === g.id ? 'Editing' : 'Configure'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {groups.length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-3 py-6 text-center text-sm text-zinc-500">No groups yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {activeGroupId && (
              <ConfigForm
                config={groupCfg}
                knowledgeDocs={groupDocs}
                onChange={setGroupCfg}
                onSave={() => void saveGroup()}
                onUploadFile={uploadGroupFile}
                onRemoveDoc={async (id) => { await removeDoc(id, 'group') }}
                saving={groupSaving}
                savedFlash={groupSaved}
                scopeLabel={`group: ${groups.find(g => g.id === activeGroupId)?.name ?? 'unknown'}`}
              />
            )}
          </div>
        )
      )}
    </div>
  )
}
