'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

export type LookupOption = { key: string; label: string }

// Mirrors ImportPreview from lib/tracker/import.ts (sent over the wire as JSON).
type CountPair = { new: number; existing: number }
type Preview = {
  counts: {
    plans: CountPair
    actions: CountPair
    contacts: CountPair
    updates: CountPair
    milestones: number
    handover: number
    reviews: number
  }
  plans: {
    legacy_id: string
    name: string
    category: string | null
    status: string | null
    parent_name: string | null
    owner_id: string
    is_new: boolean
    archived: boolean
  }[]
  regions_to_add: string[]
  errors: string[]
  notes: string[]
}

type Editor = { id: string; name: string }

// Migration 084's summary: { table: { new, changed, unchanged } } for each table.
type SummaryRow = { new: number; changed: number; unchanged: number }
type Summary = Record<string, SummaryRow>

type Step = 'choose' | 'preview' | 'result'

const MAX_FILE_BYTES = 5 * 1024 * 1024

const SUMMARY_ROWS: { key: string; label: string }[] = [
  { key: 'plans', label: 'Projects' },
  { key: 'milestones', label: 'Milestones' },
  { key: 'actions', label: 'Actions' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'updates', label: 'Updates & handover notes' },
  { key: 'reviews', label: 'Weekly reviews' },
]

export default function ImportWizard({
  categoryLabels,
  statusLabels,
}: {
  categoryLabels: LookupOption[]
  statusLabels: LookupOption[]
}) {
  const router = useRouter()
  const [step, setStep] = useState<Step>('choose')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [problems, setProblems] = useState<string[]>([])

  const [fileName, setFileName] = useState<string | null>(null)
  const [fileJson, setFileJson] = useState<unknown>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [editors, setEditors] = useState<Editor[]>([])
  const [owners, setOwners] = useState<Record<string, string>>({})
  const [summary, setSummary] = useState<Summary | null>(null)

  const categoryLabel = useMemo(() => labelMap(categoryLabels), [categoryLabels])
  const statusLabel = useMemo(() => labelMap(statusLabels), [statusLabels])

  function reset() {
    setStep('choose')
    setError(null)
    setProblems([])
    setFileName(null)
    setFileJson(null)
    setPreview(null)
    setEditors([])
    setOwners({})
    setSummary(null)
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null)
    setProblems([])
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > MAX_FILE_BYTES) {
      setError('That file is larger than 5 MB.')
      return
    }

    let text: string
    try {
      text = await file.text()
    } catch {
      setError('That file could not be read.')
      return
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      setError('That file is not valid JSON. Choose an export from the previous tracker.')
      return
    }

    setBusy(true)
    try {
      const res = await fetch('/api/tracker/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_name: file.name, file: json, owners: {} }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || 'The preview could not be built.')
        setProblems(Array.isArray(body.problems) ? body.problems : [])
        return
      }
      const nextPreview = body.data?.preview as Preview
      const nextEditors = (body.data?.editors ?? []) as Editor[]
      // Default each project's owner to the preview's chosen owner.
      const defaultOwners: Record<string, string> = {}
      for (const p of nextPreview.plans) defaultOwners[p.legacy_id] = p.owner_id
      setFileName(file.name)
      setFileJson(json)
      setPreview(nextPreview)
      setEditors(nextEditors)
      setOwners(defaultOwners)
      setStep('preview')
    } catch {
      setError('The preview could not be built.')
    } finally {
      setBusy(false)
      // Allow re-choosing the same file later.
      e.target.value = ''
    }
  }

  async function onApply() {
    if (!preview || !fileJson) return
    setBusy(true)
    setError(null)
    setProblems([])
    try {
      const res = await fetch('/api/tracker/import/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_name: fileName, file: fileJson, owners }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || 'The import could not be saved.')
        setProblems(Array.isArray(body.problems) ? body.problems : [])
        return
      }
      setSummary((body.data?.summary ?? {}) as Summary)
      setStep('result')
    } catch {
      setError('The import could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const hasErrors = (preview?.errors.length ?? 0) > 0

  return (
    <div className="space-y-4">
      {busy && (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          Working…
        </p>
      )}

      {error && (
        <div role="alert" className="space-y-1 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          <p>{error}</p>
          {problems.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5">
              {problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {step === 'choose' && (
        <div className="space-y-3 rounded-xl border bg-card p-4 text-card-foreground">
          <div className="space-y-1">
            <label htmlFor="import-file" className="text-sm font-medium">
              Export file (.json, up to 5 MB)
            </label>
            <input
              id="import-file"
              type="file"
              accept="application/json,.json"
              onChange={onFileChange}
              disabled={busy}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-accent"
            />
          </div>
          <p className="text-sm text-muted-foreground">
            We&apos;ll show you a preview before anything is saved.
          </p>
        </div>
      )}

      {step === 'preview' && preview && (
        <PreviewStep
          preview={preview}
          editors={editors}
          owners={owners}
          setOwners={setOwners}
          categoryLabel={categoryLabel}
          statusLabel={statusLabel}
          hasErrors={hasErrors}
          busy={busy}
          onApply={onApply}
          onChooseAnother={reset}
        />
      )}

      {step === 'result' && summary && (
        <ResultStep
          summary={summary}
          onImportAnother={reset}
          onGoToProjects={() => {
            router.push('/tracker/plans')
            router.refresh()
          }}
        />
      )}
    </div>
  )
}

function labelMap(options: LookupOption[]): (key: string | null) => string {
  const map = new Map(options.map((o) => [o.key, o.label]))
  return (key) => (key === null ? '—' : map.get(key) ?? key)
}

function PreviewStep({
  preview,
  editors,
  owners,
  setOwners,
  categoryLabel,
  statusLabel,
  hasErrors,
  busy,
  onApply,
  onChooseAnother,
}: {
  preview: Preview
  editors: Editor[]
  owners: Record<string, string>
  setOwners: (o: Record<string, string>) => void
  categoryLabel: (key: string | null) => string
  statusLabel: (key: string | null) => string
  hasErrors: boolean
  busy: boolean
  onApply: () => void
  onChooseAnother: () => void
}) {
  const c = preview.counts
  const tiles: { label: string; value: string }[] = [
    { label: 'Projects', value: `${c.plans.new} new, ${c.plans.existing} already imported` },
    { label: 'Milestones', value: String(c.milestones) },
    { label: 'Actions', value: `${c.actions.new} new, ${c.actions.existing} already imported` },
    { label: 'Contacts', value: `${c.contacts.new} new, ${c.contacts.existing} already imported` },
    { label: 'Updates', value: `${c.updates.new} new, ${c.updates.existing} already imported` },
    { label: 'Handover notes', value: String(c.handover) },
    { label: 'Weekly reviews', value: String(c.reviews) },
  ]

  return (
    <div className="space-y-4">
      {/* Count tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border bg-card p-3 text-card-foreground">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t.label}</p>
            <p className="mt-1 text-sm font-medium">{t.value}</p>
          </div>
        ))}
      </div>

      {/* Problems */}
      {hasErrors && (
        <div role="alert" className="space-y-1 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          <p className="font-medium">Fix these problems before importing:</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {preview.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Good to know */}
      {(preview.notes.length > 0 || preview.regions_to_add.length > 0) && (
        <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
          <p className="font-medium">Good to know</p>
          {preview.regions_to_add.length > 0 && (
            <p className="text-muted-foreground">
              New regions to add: {preview.regions_to_add.join(', ')}
            </p>
          )}
          {preview.notes.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
              {preview.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Projects table */}
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-3 py-2">Project</th>
              <th scope="col" className="px-3 py-2">Category</th>
              <th scope="col" className="px-3 py-2">Status</th>
              <th scope="col" className="px-3 py-2">State</th>
              <th scope="col" className="px-3 py-2">Owner</th>
            </tr>
          </thead>
          <tbody>
            {preview.plans.map((p) => (
              <tr key={p.legacy_id} className="border-b last:border-0">
                <td className="px-3 py-2">
                  <div className="font-medium">{p.name}</div>
                  {p.parent_name && (
                    <div className="text-xs text-muted-foreground">Sub-project of {p.parent_name}</div>
                  )}
                </td>
                <td className="px-3 py-2">{categoryLabel(p.category)}</td>
                <td className="px-3 py-2">{statusLabel(p.status)}</td>
                <td className="px-3 py-2">
                  {p.is_new ? 'New' : 'Already imported'}
                  {p.archived && <span className="text-muted-foreground"> · archived</span>}
                </td>
                <td className="px-3 py-2">
                  <label className="sr-only" htmlFor={`owner-${p.legacy_id}`}>
                    Owner for {p.name}
                  </label>
                  <select
                    id={`owner-${p.legacy_id}`}
                    value={owners[p.legacy_id] ?? ''}
                    onChange={(e) => setOwners({ ...owners, [p.legacy_id]: e.target.value })}
                    className="h-8 w-full min-w-[9rem] rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {/* The preview's chosen owner may not be an editor in the list;
                        keep it selectable so we don't silently change it. */}
                    {editors.every((ed) => ed.id !== (owners[p.legacy_id] ?? p.owner_id)) && (
                      <option value={owners[p.legacy_id] ?? p.owner_id}>Current owner</option>
                    )}
                    {editors.map((ed) => (
                      <option key={ed.id} value={ed.id}>
                        {ed.name}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={onApply} disabled={hasErrors || busy}>
          Apply import
        </Button>
        <Button variant="outline" onClick={onChooseAnother} disabled={busy}>
          Choose another file
        </Button>
      </div>
    </div>
  )
}

function ResultStep({
  summary,
  onImportAnother,
  onGoToProjects,
}: {
  summary: Summary
  onImportAnother: () => void
  onGoToProjects: () => void
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-green-600/40 bg-green-600/10 p-3 text-sm">
        <p className="font-medium">The import was saved.</p>
      </div>

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[480px] text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-3 py-2">Records</th>
              <th scope="col" className="px-3 py-2 text-right">New</th>
              <th scope="col" className="px-3 py-2 text-right">Changed</th>
              <th scope="col" className="px-3 py-2 text-right">Unchanged</th>
            </tr>
          </thead>
          <tbody>
            {SUMMARY_ROWS.map((row) => {
              const s = summary[row.key] ?? { new: 0, changed: 0, unchanged: 0 }
              return (
                <tr key={row.key} className="border-b last:border-0">
                  <td className="px-3 py-2 font-medium">{row.label}</td>
                  <td className="px-3 py-2 text-right">{s.new}</td>
                  <td className="px-3 py-2 text-right">{s.changed}</td>
                  <td className="px-3 py-2 text-right">{s.unchanged}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={onGoToProjects}>Go to Projects</Button>
        <Button variant="outline" onClick={onImportAnother}>
          Import another file
        </Button>
      </div>
    </div>
  )
}
