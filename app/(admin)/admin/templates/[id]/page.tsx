'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import type { AgentTemplate, Skill, PlatformKnowledge } from '@/lib/types'

type Tab = 'identity' | 'behaviour' | 'skills' | 'knowledge'
type FullTemplate = AgentTemplate & { skill_ids: string[]; knowledge_ids: string[] }

const CATEGORIES = ['legal','financial','marketing','operations','hr','general','technical','compliance'] as const
const COMPLEXITIES = ['standard','medium','large','massive','professional'] as const

export default function AdminTemplateEditPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id

  const [tab,         setTab]         = useState<Tab>('identity')
  const [template,    setTemplate]    = useState<FullTemplate | null>(null)
  const [allSkills,   setAllSkills]   = useState<Skill[]>([])
  const [allKnowledge, setAllKnowledge] = useState<PlatformKnowledge[]>([])
  const [loading,     setLoading]     = useState(true)
  const [saving,      setSaving]      = useState(false)
  const [toast,       setToast]       = useState<string | null>(null)

  const load = useCallback(() => {
    Promise.all([
      fetch(`/api/admin/templates/${id}`).then(r => r.json()),
      fetch('/api/admin/skills').then(r => r.json()).catch(() => ({ data: [] })),
      fetch('/api/admin/knowledge').then(r => r.json()).catch(() => ({ data: [] })),
    ])
      .then(([tJson, sJson, kJson]) => {
        setTemplate(tJson.data as FullTemplate)
        setAllSkills(sJson.data ?? [])
        setAllKnowledge(kJson.data ?? [])
      })
      .finally(() => setLoading(false))
  }, [id])
  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(t)
  }, [toast])

  function set<K extends keyof FullTemplate>(field: K, value: FullTemplate[K]) {
    setTemplate(prev => prev ? { ...prev, [field]: value } : prev)
  }

  async function save() {
    if (!template) return
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/templates/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          name:                 template.name,
          slug:                 template.slug,
          category:             template.category,
          description:          template.description,
          summary_capabilities: template.summary_capabilities,
          avatar_preset:        template.avatar_preset,
          color:                template.color,
          persona:              template.persona,
          instructions:         template.instructions,
          communication_style:  template.communication_style,
          response_length:      template.response_length,
          default_complexity:   template.default_complexity,
          is_featured:          template.is_featured,
          sort_order:           template.sort_order,
          skill_ids:            template.skill_ids,
          knowledge_ids:        template.knowledge_ids,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? 'Save failed')
      }
      setToast('Saved')
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function togglePublish() {
    if (!template) return
    const res = await fetch(`/api/admin/templates/${id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:   JSON.stringify({ is_published: !template.is_published }),
    })
    if (res.ok) {
      set('is_published', !template.is_published)
      setToast(template.is_published ? 'Unpublished' : 'Published')
    }
  }

  async function duplicate() {
    const res = await fetch(`/api/admin/templates/${id}/duplicate`, { method: 'POST' })
    const j = await res.json()
    if (res.ok && j.data?.id) router.push(`/admin/templates/${j.data.id}`)
  }

  async function remove() {
    if (!confirm('Delete this template? Agents that reference it will keep their template_id but lose the link.')) return
    const res = await fetch(`/api/admin/templates/${id}`, { method: 'DELETE' })
    if (res.ok) router.push('/admin/templates')
  }

  if (loading || !template) {
    return <div className="p-6"><p className="text-sm text-zinc-400">Loading…</p></div>
  }

  return (
    <div className="p-6 space-y-5 max-w-4xl mx-auto">
      <Link href="/admin/templates" className="text-xs text-zinc-400 hover:text-zinc-200">
        ← Back to templates
      </Link>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100 flex items-center gap-2">
            <span>{template.avatar_preset ?? '🤖'}</span>
            {template.name}
          </h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            {template.category} · v{template.version} · {template.is_published ? '● Published' : '○ Draft'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={duplicate}
            className="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-200 hover:bg-zinc-800"
          >Duplicate</button>
          <button
            onClick={togglePublish}
            className={`text-xs px-3 py-1.5 rounded border ${
              template.is_published
                ? 'border-zinc-700 text-zinc-200 hover:bg-zinc-800'
                : 'border-emerald-600 text-emerald-300 hover:bg-emerald-950/30'
            }`}
          >{template.is_published ? 'Unpublish' : 'Publish'}</button>
          <button
            onClick={save}
            disabled={saving}
            className="text-xs px-3 py-1.5 rounded bg-amber-500 text-zinc-900 font-semibold hover:bg-amber-400 disabled:opacity-60"
          >{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>

      <div className="flex gap-1 border-b border-zinc-800">
        {(['identity','behaviour','skills','knowledge'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-xs px-3 py-2 capitalize border-b-2 -mb-px ${
              tab === t
                ? 'border-amber-500 text-amber-300'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {t}
            {t === 'behaviour' && <span className="ml-1.5 text-[10px] text-zinc-500">(hidden from users)</span>}
          </button>
        ))}
      </div>

      {tab === 'identity' && (
        <div className="space-y-3">
          <Field label="Name">
            <input
              value={template.name}
              onChange={e => set('name', e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
            />
          </Field>
          <Field label="Slug">
            <input
              value={template.slug}
              onChange={e => set('slug', e.target.value)}
              className="w-full px-3 py-1.5 text-sm font-mono rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
            />
          </Field>
          <Field label="Category">
            <select
              value={template.category}
              onChange={e => set('category', e.target.value as AgentTemplate['category'])}
              className="w-full px-3 py-1.5 text-sm rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
            >
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Avatar (emoji)">
            <input
              value={template.avatar_preset ?? ''}
              onChange={e => set('avatar_preset', e.target.value)}
              className="w-24 px-3 py-1.5 text-base rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
            />
          </Field>
          <Field label="Colour (hex)">
            <input
              value={template.color ?? ''}
              onChange={e => set('color', e.target.value)}
              placeholder="#1B2A4A"
              className="w-32 px-3 py-1.5 text-sm font-mono rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
            />
          </Field>
          <Field label="Sort order">
            <input
              type="number"
              value={template.sort_order}
              onChange={e => set('sort_order', parseInt(e.target.value, 10) || 0)}
              className="w-24 px-3 py-1.5 text-sm rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
            />
          </Field>
          <Field label="Featured">
            <label className="inline-flex items-center gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={!!template.is_featured}
                onChange={e => set('is_featured', e.target.checked)}
              />
              Show in the featured strip on the create-agent gallery
            </label>
          </Field>

          <div className="border-t border-zinc-800 pt-3 mt-2 space-y-3">
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">Visible to users</p>
            <Field label="Description">
              <textarea
                value={template.description}
                onChange={e => set('description', e.target.value)}
                rows={3}
                className="w-full px-3 py-1.5 text-sm rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
              />
            </Field>
            <Field label="Summary capabilities">
              <textarea
                value={template.summary_capabilities}
                onChange={e => set('summary_capabilities', e.target.value)}
                rows={3}
                className="w-full px-3 py-1.5 text-sm rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
                placeholder="This agent can: …"
              />
            </Field>
          </div>
        </div>
      )}

      {tab === 'behaviour' && (
        <div className="space-y-3">
          <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-3 py-2">
            ⚠️ Behaviour fields are hidden from end users. They are injected into the
            agent&apos;s system prompt at run time by the runner.
          </p>
          <Field label="Persona">
            <textarea
              value={template.persona ?? ''}
              onChange={e => set('persona', e.target.value)}
              rows={3}
              className="w-full px-3 py-1.5 text-sm rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
              placeholder="You are an experienced…"
            />
          </Field>
          <Field label="Core instructions">
            <textarea
              value={template.instructions ?? ''}
              onChange={e => set('instructions', e.target.value)}
              rows={10}
              className="w-full px-3 py-1.5 text-sm rounded border border-zinc-700 bg-zinc-900 text-zinc-100 font-mono"
            />
          </Field>
          <Field label="Communication style">
            <select
              value={template.communication_style ?? ''}
              onChange={e => set('communication_style', e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
            >
              <option value="">(default)</option>
              <option value="formal">Formal</option>
              <option value="balanced">Balanced</option>
              <option value="casual">Casual</option>
            </select>
          </Field>
          <Field label="Response length">
            <select
              value={template.response_length ?? ''}
              onChange={e => set('response_length', e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
            >
              <option value="">(default)</option>
              <option value="concise">Concise</option>
              <option value="balanced">Balanced</option>
              <option value="detailed">Detailed</option>
            </select>
          </Field>
          <Field label="Default complexity (cloned to agent at creation)">
            <select
              value={template.default_complexity ?? 'standard'}
              onChange={e => set('default_complexity', e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
            >
              {COMPLEXITIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        </div>
      )}

      {tab === 'skills' && (
        <AssignList
          label="Platform skill"
          items={allSkills.map(s => ({ id: s.id, label: s.name, sub: `${s.tier} · ${s.description}` }))}
          selectedIds={template.skill_ids}
          onChange={ids => set('skill_ids', ids)}
        />
      )}

      {tab === 'knowledge' && (
        <AssignList
          label="Platform knowledge"
          items={allKnowledge.map(k => ({ id: k.id, label: k.title, sub: k.category ?? 'general' }))}
          selectedIds={template.knowledge_ids}
          onChange={ids => set('knowledge_ids', ids)}
        />
      )}

      <div className="border-t border-zinc-800 pt-3 mt-2">
        <button
          onClick={remove}
          className="text-xs text-red-400 hover:text-red-300"
        >Delete template</button>
      </div>

      {toast && (
        <div className="fixed bottom-4 right-4 px-3 py-2 rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-200">
          {toast}
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
      {children}
    </label>
  )
}

function AssignList({
  label, items, selectedIds, onChange,
}: {
  label:       string
  items:       Array<{ id: string; label: string; sub: string }>
  selectedIds: string[]
  onChange:    (ids: string[]) => void
}) {
  function toggle(id: string) {
    onChange(
      selectedIds.includes(id)
        ? selectedIds.filter(x => x !== id)
        : [...selectedIds, id],
    )
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-400">
        Assigned {label}s are injected into the agent&apos;s system prompt at run time.
        Hidden from users.
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-zinc-500">No {label}s available yet.</p>
      ) : (
        <ul className="divide-y divide-zinc-800 border border-zinc-800 rounded">
          {items.map(item => {
            const on = selectedIds.includes(item.id)
            return (
              <li key={item.id} className="flex items-start gap-3 px-3 py-2">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(item.id)}
                  className="mt-1"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-100">{item.label}</p>
                  <p className="text-xs text-zinc-500 truncate">{item.sub}</p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
