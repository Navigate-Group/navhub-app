'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { ImportPerson, ImportPreview } from '@/lib/tracker/import'

/**
 * Import wizard (P4): choose the file → preview → apply → result.
 * The file is read in the browser and sent as JSON; the server translates it
 * (lib/tracker/import.ts) and, on Apply, saves it in one transaction
 * (migration 084). Nothing is saved before Apply.
 */

const MAX_BYTES = 5 * 1024 * 1024

type Summary = Record<string, { new?: number; changed?: number; unchanged?: number; saved?: number }>

const SUMMARY_ROWS: { key: string; label: string }[] = [
  { key: 'plans', label: 'Projects' },
  { key: 'milestones', label: 'Milestones' },
  { key: 'actions', label: 'Actions' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'contact_links', label: 'Contact links' },
  { key: 'updates', label: 'Updates and handover notes' },
  { key: 'reviews', label: 'Weekly reviews' },
]

export default function ImportWizard({ labels }: { labels: Record<string, string> }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [file, setFile] = useState<unknown>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [editors, setEditors] = useState<ImportPerson[]>([])
  const [owners, setOwners] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)

  const label = (list: string, key: string | null) => (key ? labels[`${list}:${key}`] ?? key : '—')

  function reset() {
    setFileName(null)
    setFile(null)
    setPreview(null)
    setOwners({})
    setError(null)
    setProblems([])
    setSummary(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    setError(null)
    setProblems([])
    setPreview(null)
    setSummary(null)
    if (!f) return
    if (f.size > MAX_BYTES) {
      setError('The file is too large (5 MB at most).')
      return
    }
    let data: unknown
    try {
      data = JSON.parse(await f.text())
    } catch {
      setError("This file isn't valid JSON. Choose the export file from the previous tracker.")
      return
    }
    setFileName(f.name)
    setFile(data)
    setBusy('preview')
    try {
      const res = await fetch('/api/tracker/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_name: f.name, file: data }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || 'Could not read the file')
        setProblems(Array.isArray(body.errors) ? body.errors : [])
        return
      }
      const p = body.data.preview as ImportPreview
      setPreview(p)
      setEditors(body.data.editors as ImportPerson[])
      const initial: Record<string, string> = {}
      for (const plan of p.plans) initial[plan.legacy_id] = plan.owner_id
      setOwners(initial)
    } catch {
      setError('Could not read the file')
    } finally {
      setBusy(null)
    }
  }

  async function onApply() {
    if (!preview || !file) return
    setBusy('apply')
    setError(null)
    setProblems([])
    try {
      const res = await fetch('/api/tracker/import/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_name: fileName, file, owners }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || 'The import could not be saved. Nothing was changed.')
        setProblems(Array.isArray(body.errors) ? body.errors : [])
        return
      }
      setSummary(body.data.summary as Summary)
      router.refresh()
    } catch {
      setError('The import could not be saved. Nothing was changed.')
    } finally {
      setBusy(null)
    }
  }

  // ── Result ──
  if (summary) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Import complete</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground" role="status">
            {fileName} was imported.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th scope="col" className="py-2 pr-4 font-medium">Record</th>
                  <th scope="col" className="py-2 pr-4 font-medium">New</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Changed</th>
                  <th scope="col" className="py-2 font-medium">Unchanged</th>
                </tr>
              </thead>
              <tbody>
                {SUMMARY_ROWS.map((r) => {
                  const s = summary[r.key] ?? {}
                  return (
                    <tr key={r.key} className="border-b last:border-0">
                      <th scope="row" className="py-2 pr-4 font-normal">{r.label}</th>
                      <td className="py-2 pr-4">{s.new ?? s.saved ?? 0}</td>
                      <td className="py-2 pr-4">{s.changed ?? '—'}</td>
                      <td className="py-2">{s.unchanged ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/tracker/plans">Go to Projects</Link>
            </Button>
            <Button variant="outline" onClick={reset}>Import another file</Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  const blocked = (preview?.errors.length ?? 0) > 0
  const c = preview?.counts

  return (
    <div className="space-y-4">
      {/* Step 1: choose the file */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Choose the export file</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <label htmlFor="import-file" className="block text-sm font-medium">
            Export file from the previous tracker (.json)
          </label>
          <input
            ref={inputRef}
            id="import-file"
            type="file"
            accept=".json,application/json"
            onChange={onFile}
            disabled={busy !== null}
            className="block w-full max-w-md text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-muted"
          />
          <p className="text-xs text-muted-foreground">
            Nothing is saved until you choose Apply. Importing the same file again later updates what changed
            instead of adding duplicates.
          </p>
          <div aria-live="polite" className="text-sm">
            {busy === 'preview' && <p className="text-muted-foreground">Reading the file…</p>}
          </div>
        </CardContent>
      </Card>

      {error && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="font-medium text-destructive">{error}</p>
          {problems.length > 1 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-destructive">
              {problems.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* Step 2: preview */}
      {preview && c && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">2. Check the preview</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <ul className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {[
                { label: 'Projects', n: c.plans.new + c.plans.existing, sub: `${c.plans.new} new` },
                { label: 'Milestones', n: c.milestones },
                { label: 'Actions', n: c.actions.new + c.actions.existing, sub: `${c.actions.new} new` },
                { label: 'Contacts', n: c.contacts.new + c.contacts.existing, sub: `${c.contacts.new} new` },
                { label: 'Updates', n: c.updates.new + c.updates.existing, sub: `${c.updates.new} new` },
                { label: 'Handover notes', n: c.handover },
                { label: 'Weekly reviews', n: c.reviews },
              ].map((t) => (
                <li key={t.label} className="rounded-md border p-3">
                  <div className="text-lg font-semibold">{t.n}</div>
                  <div className="text-muted-foreground">{t.label}</div>
                  {t.sub && <div className="text-xs text-muted-foreground">{t.sub}</div>}
                </li>
              ))}
            </ul>

            {blocked && (
              <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <p className="font-medium text-destructive">
                  The file has {preview.errors.length} problem{preview.errors.length === 1 ? '' : 's'}, so it can&apos;t be
                  imported:
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-destructive">
                  {preview.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}

            {(preview.notes.length > 0 || preview.regions_to_add.length > 0) && (
              <div className="rounded-md border bg-muted/40 p-3 text-sm">
                <p className="font-medium">Good to know</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                  {preview.regions_to_add.length > 0 && (
                    <li>New regions will be added to the group&apos;s list: {preview.regions_to_add.join(', ')}.</li>
                  )}
                  {preview.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </div>
            )}

            <div>
              <h3 className="mb-2 text-sm font-medium">Projects and their owners</h3>
              <p className="mb-2 text-xs text-muted-foreground">
                Every project needs an owner who is a Manager or Group Owner. New projects default to you.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th scope="col" className="py-2 pr-4 font-medium">Project</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Category</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                      <th scope="col" className="py-2 pr-4 font-medium">In NavHub</th>
                      <th scope="col" className="py-2 font-medium">Owner</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.plans.map((p) => (
                      <tr key={p.legacy_id} className="border-b last:border-0 align-top">
                        <th scope="row" className="py-2 pr-4 font-normal">
                          <div className="font-medium">{p.name}</div>
                          {p.parent_name && (
                            <div className="text-xs text-muted-foreground">Sub-project of {p.parent_name}</div>
                          )}
                        </th>
                        <td className="py-2 pr-4">{label('category', p.category)}</td>
                        <td className="py-2 pr-4">{label('status', p.status)}</td>
                        <td className="py-2 pr-4">
                          {p.is_new ? (
                            <Badge variant="secondary">New</Badge>
                          ) : (
                            <Badge variant="outline">{p.archived ? 'Already imported, archived' : 'Already imported'}</Badge>
                          )}
                        </td>
                        <td className="py-2">
                          <label className="sr-only" htmlFor={`owner-${p.legacy_id}`}>Owner of {p.name}</label>
                          <select
                            id={`owner-${p.legacy_id}`}
                            value={owners[p.legacy_id] ?? p.owner_id}
                            onChange={(e) => setOwners((o) => ({ ...o, [p.legacy_id]: e.target.value }))}
                            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                          >
                            {editors.map((e) => (
                              <option key={e.id} value={e.id}>{e.name || '—'}</option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={onApply} disabled={blocked || busy !== null}>
                {busy === 'apply' ? 'Importing…' : 'Apply import'}
              </Button>
              <Button variant="outline" onClick={reset} disabled={busy !== null}>Choose another file</Button>
              <span className="text-xs text-muted-foreground" aria-live="polite">
                {busy === 'apply' ? 'Saving everything in one go…' : 'All of it is saved, or none of it.'}
              </span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
