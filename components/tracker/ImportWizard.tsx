'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { ImportPreview, PreviewProjectRow } from '@/lib/tracker/import'

const MAX_BYTES = 5 * 1024 * 1024 // 5 MB

type Editor = { id: string; name: string }

type Step = 'choose' | 'preview' | 'done'

const selectClass = cn(
  'h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm',
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
)

/**
 * The import wizard (P4). Three steps:
 *   1. Choose a JSON export (5 MB max). We read it in the browser and POST it to
 *      /api/tracker/import/preview.
 *   2. Preview: count tiles, problems, notes, new regions, and a projects table
 *      with an owner picker per project. Apply is disabled while any owner is
 *      unchosen or any problem remains.
 *   3. Done: show the summary of what was inserted / updated.
 *
 * The database is the guard — the preview and apply both run as the signed-in
 * user; a non-editor is refused server-side. This component only orchestrates.
 */
export default function ImportWizard() {
  const router = useRouter()
  const [step, setStep] = useState<Step>('choose')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The raw file text + name are kept so apply can re-translate server-side.
  const [raw, setRaw] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string>('')

  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [editors, setEditors] = useState<Editor[]>([])
  // Owner choices the user makes in the table: old plan id → owner id.
  const [owners, setOwners] = useState<Record<string, string>>({})
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null)

  async function onChooseFile(file: File) {
    setError(null)
    if (file.size > MAX_BYTES) {
      setError('The file is larger than 5 MB.')
      return
    }
    const text = await file.text()
    setRaw(text)
    setFileName(file.name || 'import.json')
    setBusy(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/tracker/import/preview', { method: 'POST', body: form })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error || 'The file could not be read.')
        setBusy(false)
        return
      }
      const p = json.preview as ImportPreview
      setPreview(p)
      setEditors(json.editors ?? [])
      // Seed owner picks from the translator's matches.
      const seed: Record<string, string> = {}
      for (const row of p.projects) if (row.ownerId) seed[row.legacy_id] = row.ownerId
      setOwners(seed)
      setStep('preview')
    } catch {
      setError('The file could not be read.')
    } finally {
      setBusy(false)
    }
  }

  // A project still needs an owner when none is chosen in the picker.
  const unchosen = useMemo(() => {
    if (!preview) return []
    return preview.projects.filter((r) => !owners[r.legacy_id])
  }, [preview, owners])

  const blocked = useMemo(() => {
    if (!preview) return true
    if (unchosen.length > 0) return true
    // Problems other than "choose an owner" (those clear as owners are picked).
    return preview.problems.some((p) => !/^choose an owner/i.test(p))
  }, [preview, unchosen])

  async function onApply() {
    if (!raw || !preview) return
    setBusy(true)
    setError(null)
    try {
      const ownerChoices = Object.entries(owners).map(([legacyPlanId, ownerId]) => ({
        legacyPlanId,
        ownerId,
      }))
      const res = await fetch('/api/tracker/import/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw, fileName, ownerChoices }),
      })
      const json = await res.json()
      if (!res.ok) {
        if (Array.isArray(json.problems) && json.problems.length > 0) {
          setError(json.problems.join(' '))
        } else {
          setError(json.error || 'The import could not be applied.')
        }
        setBusy(false)
        return
      }
      setSummary(json.summary ?? {})
      setStep('done')
    } catch {
      setError('The import could not be applied.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
          {error}
        </div>
      )}

      {step === 'choose' && <ChooseStep busy={busy} onChoose={onChooseFile} />}

      {step === 'preview' && preview && (
        <PreviewStep
          preview={preview}
          editors={editors}
          owners={owners}
          setOwner={(id, ownerId) => setOwners((prev) => ({ ...prev, [id]: ownerId }))}
          blocked={blocked}
          busy={busy}
          onBack={() => {
            setStep('choose')
            setPreview(null)
            setError(null)
          }}
          onApply={onApply}
        />
      )}

      {step === 'done' && (
        <DoneStep
          summary={summary}
          onDone={() => {
            router.push('/tracker/plans')
            router.refresh()
          }}
        />
      )}
    </div>
  )
}

function ChooseStep({ busy, onChoose }: { busy: boolean; onChoose: (f: File) => void }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Choose the previous tracker&apos;s export file (a <code>.json</code> file, up to 5 MB). You&apos;ll
        see a preview of what will be imported before anything is saved.
      </p>
      <label className="flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-8 text-center hover:bg-muted/50">
        <span className="text-sm font-medium">{busy ? 'Reading…' : 'Click to choose a file'}</span>
        <span className="text-xs text-muted-foreground">JSON only · 5 MB max</span>
        <input
          type="file"
          accept="application/json,.json"
          className="sr-only"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onChoose(f)
            e.target.value = '' // allow re-choosing the same file
          }}
        />
      </label>
    </div>
  )
}

function CountTile({ label, counts }: { label: string; counts: { new: number; changed: number } }) {
  return (
    <div className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="text-sm font-semibold">{label}</div>
      <div className="mt-1 flex flex-wrap gap-2 text-xs">
        <Badge variant="success">{counts.new} new</Badge>
        <Badge variant="secondary">{counts.changed} changed</Badge>
      </div>
    </div>
  )
}

function PreviewStep({
  preview,
  editors,
  owners,
  setOwner,
  blocked,
  busy,
  onBack,
  onApply,
}: {
  preview: ImportPreview
  editors: Editor[]
  owners: Record<string, string>
  setOwner: (legacyId: string, ownerId: string) => void
  blocked: boolean
  busy: boolean
  onBack: () => void
  onApply: () => void
}) {
  const c = preview.counts
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <CountTile label="Projects" counts={c.plans} />
        <CountTile label="Milestones" counts={c.milestones} />
        <CountTile label="Actions" counts={c.actions} />
        <CountTile label="Contacts" counts={c.contacts} />
        <CountTile label="Updates" counts={c.updates} />
      </div>

      {preview.problems.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-red-700 dark:text-red-400">
            Problems to fix before importing
          </h2>
          <ul className="list-disc space-y-1 pl-5 text-sm text-red-700 dark:text-red-400">
            {preview.problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </section>
      )}

      {preview.newRegions.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">New regions to be added</h2>
          <div className="flex flex-wrap gap-2">
            {preview.newRegions.map((r) => (
              <Badge key={r.key} variant="outline">
                {r.label}
              </Badge>
            ))}
          </div>
        </section>
      )}

      {preview.notes.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Notes</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {preview.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Projects</h2>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Project</th>
                <th className="px-3 py-2">State</th>
                <th className="px-3 py-2">Milestones</th>
                <th className="px-3 py-2">Actions</th>
                <th className="px-3 py-2">Owner</th>
              </tr>
            </thead>
            <tbody>
              {preview.projects.map((row) => (
                <ProjectRow
                  key={row.legacy_id}
                  row={row}
                  editors={editors}
                  value={owners[row.legacy_id] ?? ''}
                  onChange={(id) => setOwner(row.legacy_id, id)}
                />
              ))}
              {preview.projects.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-muted-foreground">
                    No projects in this file.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={onBack} disabled={busy}>
          Choose a different file
        </Button>
        <Button onClick={onApply} disabled={blocked || busy}>
          {busy ? 'Importing…' : 'Import'}
        </Button>
        {blocked && (
          <span className="text-xs text-muted-foreground">
            Fix the problems and choose an owner for each project to import.
          </span>
        )}
      </div>
    </div>
  )
}

function ProjectRow({
  row,
  editors,
  value,
  onChange,
}: {
  row: PreviewProjectRow
  editors: Editor[]
  value: string
  onChange: (ownerId: string) => void
}) {
  return (
    <tr className="border-t">
      <td className="px-3 py-2 font-medium">{row.name}</td>
      <td className="px-3 py-2">
        <Badge variant={row.state === 'new' ? 'success' : 'secondary'}>{row.state}</Badge>
      </td>
      <td className="px-3 py-2">{row.milestones}</td>
      <td className="px-3 py-2">{row.actions}</td>
      <td className="px-3 py-2">
        <select
          className={selectClass}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`Owner for ${row.name}`}
        >
          <option value="">Choose an owner…</option>
          {editors.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name || '—'}
            </option>
          ))}
        </select>
        {row.ownerName && !value && (
          <p className="mt-1 text-xs text-muted-foreground">Was &ldquo;{row.ownerName}&rdquo;</p>
        )}
      </td>
    </tr>
  )
}

function DoneStep({
  summary,
  onDone,
}: {
  summary: Record<string, unknown> | null
  onDone: () => void
}) {
  const rows = summary ? summaryRows(summary) : []
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-900/20 dark:text-emerald-300">
        Import complete.
      </div>
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">What</th>
                <th className="px-3 py-2">Added</th>
                <th className="px-3 py-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="border-t">
                  <td className="px-3 py-2 font-medium">{r.label}</td>
                  <td className="px-3 py-2">{r.inserted}</td>
                  <td className="px-3 py-2">{r.updated ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Button onClick={onDone}>Back to Projects</Button>
    </div>
  )
}

function summaryRows(
  summary: Record<string, unknown>,
): { label: string; inserted: number; updated: number | null }[] {
  const labels: Record<string, string> = {
    plans: 'Projects',
    milestones: 'Milestones',
    actions: 'Actions',
    contacts: 'Contacts',
    contact_links: 'Contact links',
    updates: 'Updates',
    regions: 'Regions',
  }
  const out: { label: string; inserted: number; updated: number | null }[] = []
  for (const [key, label] of Object.entries(labels)) {
    const v = summary[key]
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      out.push({
        label,
        inserted: typeof o.inserted === 'number' ? o.inserted : 0,
        updated: typeof o.updated === 'number' ? o.updated : null,
      })
    }
  }
  return out
}
