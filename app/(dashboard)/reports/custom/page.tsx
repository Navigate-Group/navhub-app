'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import Link from 'next/link'
import {
  FileText, Upload, Plus, X, Check, Loader2, BookOpen, Share2,
  Search, LayoutGrid, List, ChevronDown, Sparkles, Tag,
  ArrowUpDown, MoreHorizontal, Pencil, Download, Eye, Trash2,
  Folder, FolderOpen, LayoutTemplate,
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button }    from '@/components/ui/button'
import { Input }     from '@/components/ui/input'
import { Label }     from '@/components/ui/label'
import { Badge }     from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn }        from '@/lib/utils'
import type { CustomReport } from '@/lib/types'
import TagEditor from '@/components/shared/TagEditor'

const MAX_FILE_MB    = 5
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024

type SortOption   = 'newest' | 'oldest' | 'name_asc' | 'name_desc'
type SourceFilter = 'all' | 'agent' | 'manual'
type ViewMode     = 'grid' | 'table'

const SORT_LABELS: Record<SortOption, string> = {
  newest:    'Newest first',
  oldest:    'Oldest first',
  name_asc:  'Name A–Z',
  name_desc: 'Name Z–A',
}

function relativeDate(iso: string): string {
  const d    = new Date(iso)
  const now  = new Date()
  const diff = (now.getTime() - d.getTime()) / 1000
  if (diff < 60)           return 'just now'
  if (diff < 3600)         return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400)        return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 7)   return `${Math.floor(diff / 86400)}d ago`
  if (diff < 86400 * 30)  return `${Math.floor(diff / 86400 / 7)}w ago`
  return d.toLocaleDateString()
}

// ── Reports Library Page ───────────────────────────────────────────────────────

export default function ReportsLibraryPage() {
  const [reports,    setReports]    = useState<CustomReport[]>([])
  const [loading,    setLoading]    = useState(true)
  const [isAdmin,    setIsAdmin]    = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [allTags,    setAllTags]    = useState<string[]>([])

  // Folder state
  type ReportFolder = { id: string; name: string; is_system: boolean; folder_type: string }
  const [folders,       setFolders]       = useState<ReportFolder[]>([])
  const [activeFolder,  setActiveFolder]  = useState<string | null>(null)
  const [newFolderName, setNewFolderName] = useState('')
  const [addingFolder,  setAddingFolder]  = useState(false)
  const [folderLoading, setFolderLoading] = useState(false)

  // Filters & view
  const [view,         setView]         = useState<ViewMode>('grid')
  const [search,       setSearch]       = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [source,       setSource]       = useState<SourceFilter>('all')
  const [sort,         setSort]         = useState<SortOption>('newest')
  const [tagsOpen,     setTagsOpen]     = useState(false)
  const tagsRef = useRef<HTMLDivElement>(null)

  // Upload form
  const [file,        setFile]        = useState<File | null>(null)
  const [reportName,  setReportName]  = useState('')
  const [description, setDescription] = useState('')
  const [uploading,   setUploading]   = useState(false)
  const [uploadToast, setUploadToast] = useState<string | null>(null)
  const [dragOver,    setDragOver]    = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Initialise view from localStorage ───────────────────────────────────────
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('navhub:reports:view') as ViewMode | null
      if (saved === 'grid' || saved === 'table') setView(saved)
    }
  }, [])

  function setViewMode(v: ViewMode) {
    setView(v)
    if (typeof window !== 'undefined') localStorage.setItem('navhub:reports:view', v)
  }

  // ── Load reports, admin status, tags ────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [rRes, gRes, tRes, fRes] = await Promise.all([
        fetch('/api/reports/custom'),
        fetch('/api/groups/active'),
        fetch('/api/reports/custom/tags'),
        fetch('/api/report-folders'),
      ])
      const rJson = await rRes.json()
      const gJson = await gRes.json()
      const tJson = await tRes.json()
      const fJson = fRes.ok ? await fRes.json() : { data: [] }

      if (rJson.data) setReports(rJson.data as CustomReport[])
      if (gJson.data) setIsAdmin(gJson.data.is_admin)
      if (tJson.data) setAllTags(tJson.data as string[])
      setFolders(fJson.data ?? [])
    } catch { /* silent */ } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadData() }, [loadData])

  // ── Toast auto-dismiss ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!uploadToast) return
    const t = setTimeout(() => setUploadToast(null), 4000)
    return () => clearTimeout(t)
  }, [uploadToast])

  // ── Close tags dropdown on outside click ────────────────────────────────────
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (tagsRef.current && !tagsRef.current.contains(e.target as Node)) {
        setTagsOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ── Filtered + sorted reports ────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let r = [...reports]

    // Folder filter
    if (activeFolder === 'unfiled') r = r.filter(rep => !rep.folder_id)
    else if (activeFolder) r = r.filter(rep => rep.folder_id === activeFolder)

    // Search
    if (search.trim()) {
      const q = search.toLowerCase()
      r = r.filter(rep =>
        rep.name.toLowerCase().includes(q) ||
        (rep.description ?? '').toLowerCase().includes(q) ||
        (rep.tags ?? []).some((t: string) => t.includes(q))
      )
    }

    // Source
    if (source === 'agent')  r = r.filter(rep => rep.uploaded_by === 'agent')
    if (source === 'manual') r = r.filter(rep => rep.uploaded_by !== 'agent')

    // Tags (AND logic — must have all selected tags)
    if (selectedTags.length > 0) {
      r = r.filter(rep =>
        selectedTags.every(tag => (rep.tags ?? []).includes(tag))
      )
    }

    // Sort
    if (sort === 'newest')    r.sort((a, b) => b.created_at.localeCompare(a.created_at))
    if (sort === 'oldest')    r.sort((a, b) => a.created_at.localeCompare(b.created_at))
    if (sort === 'name_asc')  r.sort((a, b) => a.name.localeCompare(b.name))
    if (sort === 'name_desc') r.sort((a, b) => b.name.localeCompare(a.name))

    return r
  }, [reports, search, source, selectedTags, sort, activeFolder])

  const hasFilters = search !== '' || selectedTags.length > 0 || source !== 'all' || sort !== 'newest'

  function clearFilters() {
    setSearch('')
    setSelectedTags([])
    setSource('all')
    setSort('newest')
  }

  // ── File handling ────────────────────────────────────────────────────────────
  function handleFileSelect(selected: File | null) {
    if (!selected) return
    if (!selected.name.endsWith('.html') && !selected.name.endsWith('.htm')) {
      setUploadToast('Only .html files are supported')
      return
    }
    if (selected.size > MAX_FILE_BYTES) {
      setUploadToast(`File must be under ${MAX_FILE_MB} MB`)
      return
    }
    setFile(selected)
    if (!reportName) {
      setReportName(
        selected.name
          .replace(/\.(html?)/i, '')
          .replace(/[-_]+/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase())
      )
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const dropped = e.dataTransfer.files[0]
    if (dropped) handleFileSelect(dropped)
  }

  async function handleUpload() {
    if (!file || !reportName.trim()) {
      setUploadToast('Report name and file are required')
      return
    }
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file',        file)
      form.append('name',        reportName.trim())
      form.append('description', description.trim())

      const res  = await fetch('/api/reports/custom', { method: 'POST', body: form })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Upload failed')

      setReports(rs => [...rs, json.data as CustomReport])
      setFile(null)
      setReportName('')
      setDescription('')
      setShowUpload(false)
      setUploadToast(`"${(json.data as CustomReport).name}" uploaded successfully`)
    } catch (err) {
      setUploadToast(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function handleToggleStatus(report: CustomReport) {
    const newStatus = report.status === 'published' ? 'draft' : 'published'
    try {
      const res = await fetch(`/api/reports/custom/${report.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      if (res.ok) {
        setReports(rs => rs.map(r => r.id === report.id ? { ...r, status: newStatus } : r))
      }
    } catch { /* ignore */ }
  }

  async function handleRename(report: CustomReport, name: string) {
    await fetch(`/api/reports/custom/${report.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    setReports(rs => rs.map(r => r.id === report.id ? { ...r, name } : r))
  }

  async function handleSaveTags(report: CustomReport, tags: string[]) {
    await fetch(`/api/reports/custom/${report.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags }),
    })
    setReports(rs => rs.map(r => r.id === report.id ? { ...r, tags } : r))
  }

  async function handleAddFolder() {
    if (!newFolderName.trim()) return
    setFolderLoading(true)
    try {
      const res = await fetch('/api/report-folders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newFolderName.trim() }),
      })
      const json = await res.json()
      if (res.ok) {
        setFolders(prev => [...prev, json.data])
        setNewFolderName(''); setAddingFolder(false)
      }
    } finally { setFolderLoading(false) }
  }

  async function handleDelete(report: CustomReport) {
    if (!confirm(`Delete "${report.name}"? This cannot be undone.`)) return
    try {
      const res  = await fetch(`/api/reports/custom/${report.id}`, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to delete')
      setReports(rs => rs.filter(r => r.id !== report.id))
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete')
    }
  }

  // ── Report card (grid) ───────────────────────────────────────────────────────
  function ReportCard({ report }: { report: CustomReport }) {
    const tags = report.tags ?? []
    const [editingTags, setEditingTags] = useState(false)
    const [renaming, setRenaming] = useState(false)
    const [renameVal, setRenameVal] = useState(report.name)
    const [cardMenuOpen, setCardMenuOpen] = useState(false)

    function submitRename() {
      if (renameVal.trim() && renameVal.trim() !== report.name) void handleRename(report, renameVal.trim())
      setRenaming(false)
    }

    return (
      <Card className="group relative hover:border-primary/50 transition-colors flex flex-col">
        <Link href={`/reports/custom/${report.id}`} className="flex-1 p-4 space-y-2.5">
          <div className="flex items-start gap-2">
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <FileText className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              {renaming ? (
                <input autoFocus value={renameVal} onChange={e => setRenameVal(e.target.value)}
                  onBlur={submitRename} onClick={e => e.preventDefault()}
                  onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenaming(false) }}
                  className="text-sm font-semibold bg-transparent border-b border-primary outline-none w-full" />
              ) : (
                <p className="text-sm font-semibold leading-snug line-clamp-2">{report.name}</p>
              )}
              {report.description && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{report.description}</p>}
            </div>
          </div>

          <div className="flex flex-wrap gap-1">
            {report.status === 'published' ? (
              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300">Published</span>
            ) : (
              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground">Draft</span>
            )}
            {report.uploaded_by === 'agent' && <Sparkles className="h-3 w-3 text-purple-400" />}
            {report.is_shareable && <Share2 className="h-3 w-3 text-emerald-500" />}
            {tags.slice(0, 3).map(t => (
              <span key={t} className="inline-flex items-center rounded-full px-1.5 py-0 text-[10px] font-medium bg-secondary text-secondary-foreground">{t}</span>
            ))}
            {tags.length > 3 && <span className="text-[10px] text-muted-foreground">+{tags.length - 3}</span>}
          </div>

          <p className="text-[11px] text-muted-foreground">{relativeDate(report.created_at)}</p>
        </Link>

        {editingTags && (
          <div className="px-4 pb-3" onClick={e => e.stopPropagation()}>
            <TagEditor tags={tags} allTags={allTags} compact
              onSave={async (t) => { await handleSaveTags(report, t); setEditingTags(false) }} />
          </div>
        )}

        <div className="border-t px-3 py-1.5 flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-6 text-[11px] px-2" asChild>
            <Link href={`/reports/custom/${report.id}`}><Eye className="h-3 w-3 mr-1" />Open</Link>
          </Button>
          {isAdmin && (
            <Button size="sm" variant="ghost" className="h-6 text-[11px] px-2"
              onClick={() => void handleToggleStatus(report)}>
              {report.status === 'published' ? 'Unpublish' : 'Publish'}
            </Button>
          )}
          <div className="ml-auto relative">
            <button onClick={() => setCardMenuOpen(o => !o)} className="rounded-md p-1 hover:bg-muted transition-colors">
              <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
            {cardMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setCardMenuOpen(false)} />
                <div className="absolute right-0 bottom-7 z-20 bg-background border rounded-lg shadow-lg py-1 w-44 text-sm">
                  <button className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted text-left"
                    onClick={() => { setEditingTags(true); setCardMenuOpen(false) }}>
                    <Tag className="h-3.5 w-3.5" /> Tags
                  </button>
                  <button className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted text-left"
                    onClick={() => { setRenaming(true); setCardMenuOpen(false) }}>
                    <Pencil className="h-3.5 w-3.5" /> Rename
                  </button>
                  <button className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted text-left"
                    onClick={() => { window.open(`/api/reports/custom/${report.id}/file`, '_blank'); setCardMenuOpen(false) }}>
                    <Download className="h-3.5 w-3.5" /> Download
                  </button>
                  {isAdmin && (
                    <>
                      <div className="border-t my-1" />
                      <button className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted text-left text-destructive"
                        onClick={() => { void handleDelete(report); setCardMenuOpen(false) }}>
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </Card>
    )
  }

  // ── Table row ────────────────────────────────────────────────────────────────
  function TableRow({ report }: { report: CustomReport }) {
    const tags = report.tags ?? []
    return (
      <tr className="border-b last:border-b-0 hover:bg-muted/30 transition-colors group">
        {/* Name */}
        <td className="py-2.5 px-3">
          <div className="flex items-center gap-2">
            {report.uploaded_by === 'agent' && (
              <Sparkles className="h-3.5 w-3.5 text-purple-400 shrink-0" />
            )}
            <div>
              <p className="text-sm font-medium leading-snug">{report.name}</p>
              {report.description && (
                <p className="text-xs text-muted-foreground truncate max-w-xs">{report.description}</p>
              )}
            </div>
          </div>
        </td>

        {/* Tags */}
        <td className="py-2.5 px-3">
          <div className="flex gap-1 flex-wrap">
            {tags.slice(0, 4).map(tag => (
              <Badge
                key={tag}
                variant="secondary"
                className="text-[10px] px-1.5 py-0 cursor-pointer"
                onClick={() => {
                  if (!selectedTags.includes(tag)) {
                    setSelectedTags(prev => [...prev, tag])
                  }
                }}
              >
                {tag}
              </Badge>
            ))}
            {tags.length > 4 && (
              <span className="text-[10px] text-muted-foreground">+{tags.length - 4}</span>
            )}
          </div>
        </td>

        {/* Source */}
        <td className="py-2.5 px-3">
          <span className="text-xs text-muted-foreground">
            {report.uploaded_by === 'agent' ? 'Agent' : 'Manual'}
          </span>
        </td>

        {/* Shared */}
        <td className="py-2.5 px-3">
          {report.is_shareable && (
            <Badge
              variant="outline"
              className="text-[10px] gap-1 border-emerald-400/50 text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30"
            >
              <Share2 className="h-2.5 w-2.5" /> Shared
            </Badge>
          )}
        </td>

        {/* Date */}
        <td className="py-2.5 px-3">
          <span className="text-xs text-muted-foreground">{relativeDate(report.created_at)}</span>
        </td>

        {/* Actions */}
        <td className="py-2.5 px-3 text-right">
          <div className="flex items-center gap-1 justify-end">
            <Button size="sm" variant="outline" className="h-7 text-xs px-2.5" asChild>
              <Link href={`/reports/custom/${report.id}`}>Open</Link>
            </Button>
            {isAdmin && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem asChild>
                    <Link href={`/reports/custom/${report.id}`}>Open</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href={`/reports/custom/${report.id}`}>Edit tags</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => void handleToggleStatus(report)}
                  >
                    {report.status === 'published' ? 'Unpublish' : 'Publish'}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => void handleDelete(report)}
                  >
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </td>
      </tr>
    )
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const countAll     = reports.length
  const countUnfiled = reports.filter(r => !r.folder_id).length
  const folderCounts = folders.reduce<Record<string, number>>((acc, f) => {
    acc[f.id] = reports.filter(r => r.folder_id === f.id).length
    return acc
  }, {})

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)]">
      {/* ── Folder sidebar ── */}
      <aside className="hidden lg:flex flex-col w-52 border-r shrink-0 py-4 px-3 space-y-1">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-2 mb-2">Folders</p>
        <button onClick={() => setActiveFolder(null)}
          className={cn('flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-sm text-left transition-colors',
            activeFolder === null ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted')}>
          <FolderOpen className="h-4 w-4 shrink-0" /><span className="flex-1 truncate">All Reports</span>
          <span className="text-xs text-muted-foreground">{countAll}</span>
        </button>
        <button onClick={() => setActiveFolder('unfiled')}
          className={cn('flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-sm text-left transition-colors',
            activeFolder === 'unfiled' ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted')}>
          <Folder className="h-4 w-4 shrink-0" /><span className="flex-1 truncate">Unfiled</span>
          <span className="text-xs text-muted-foreground">{countUnfiled}</span>
        </button>
        {folders.filter(f => f.folder_type === 'templates').map(f => (
          <button key={f.id} onClick={() => setActiveFolder(f.id)}
            className={cn('flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-sm text-left transition-colors',
              activeFolder === f.id ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted')}>
            <LayoutTemplate className="h-4 w-4 shrink-0" /><span className="flex-1 truncate">{f.name}</span>
            <span className="text-xs text-muted-foreground">{folderCounts[f.id] ?? 0}</span>
          </button>
        ))}
        {folders.filter(f => f.folder_type !== 'templates').map(f => (
          <button key={f.id} onClick={() => setActiveFolder(f.id)}
            className={cn('flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-sm text-left transition-colors',
              activeFolder === f.id ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted')}>
            <Folder className="h-4 w-4 shrink-0" /><span className="flex-1 truncate">{f.name}</span>
            <span className="text-xs text-muted-foreground">{folderCounts[f.id] ?? 0}</span>
          </button>
        ))}
        {isAdmin && (
          <div className="pt-2 border-t mt-2">
            {addingFolder ? (
              <div className="space-y-1.5">
                <input autoFocus value={newFolderName} onChange={e => setNewFolderName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void handleAddFolder(); if (e.key === 'Escape') setAddingFolder(false) }}
                  placeholder="Folder name…"
                  className="flex h-7 w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
                <div className="flex gap-1">
                  <Button size="sm" className="h-6 text-xs flex-1" onClick={() => void handleAddFolder()} disabled={folderLoading}>
                    {folderLoading ? '…' : 'Add'}
                  </Button>
                  <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => setAddingFolder(false)}>×</Button>
                </div>
              </div>
            ) : (
              <button onClick={() => setAddingFolder(true)}
                className="flex items-center gap-1.5 w-full text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-muted transition-colors">
                <Plus className="h-3 w-3" /> New Folder
              </button>
            )}
          </div>
        )}
      </aside>

      {/* ── Main content ── */}
      <div className="flex-1 min-w-0 px-6 py-6 space-y-5">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <BookOpen className="h-6 w-6" /> Reports Library
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Custom HTML reports uploaded by your group admins
          </p>
        </div>
        {isAdmin && !showUpload && (
          <Button size="sm" onClick={() => setShowUpload(true)}>
            <Plus className="h-4 w-4 mr-1.5" /> Upload report
          </Button>
        )}
      </div>

      {/* ── Toast ──────────────────────────────────────────────────────── */}
      {uploadToast && (
        <div className={cn(
          'flex items-center gap-2 rounded-md px-4 py-2.5 text-sm',
          uploadToast.includes('success') || uploadToast.includes('successfully')
            ? 'bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800'
            : 'bg-destructive/10 text-destructive border border-destructive/20'
        )}>
          {(uploadToast.includes('success') || uploadToast.includes('successfully'))
            ? <Check className="h-4 w-4 shrink-0" />
            : <X     className="h-4 w-4 shrink-0" />}
          {uploadToast}
        </div>
      )}

      {/* ── Upload panel ────────────────────────────────────────────────── */}
      {showUpload && isAdmin && (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between">
              <div>
                <CardTitle className="text-base">Upload Report</CardTitle>
                <CardDescription>HTML files only · Max {MAX_FILE_MB} MB</CardDescription>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => { setShowUpload(false); setFile(null); setReportName(''); setDescription('') }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              onDrop={handleDrop}
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                'border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors',
                dragOver
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/50 hover:bg-muted/30',
                file && 'border-green-500 bg-green-50 dark:bg-green-950/30'
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".html,.htm"
                className="hidden"
                onChange={e => handleFileSelect(e.target.files?.[0] ?? null)}
              />
              {file ? (
                <div className="space-y-1">
                  <Check className="h-8 w-8 text-green-500 mx-auto" />
                  <p className="text-sm font-medium text-green-700 dark:text-green-300">{file.name}</p>
                  <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <Upload className="h-8 w-8 text-muted-foreground mx-auto" />
                  <p className="text-sm text-muted-foreground">
                    Drag & drop an HTML file, or <span className="text-primary font-medium">browse</span>
                  </p>
                </div>
              )}
            </div>

            <div className="grid gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="report-name">Report name <span className="text-destructive">*</span></Label>
                <Input
                  id="report-name"
                  value={reportName}
                  onChange={e => setReportName(e.target.value)}
                  placeholder="Q1 2026 Financial Summary"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="report-desc">Description <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Input
                  id="report-desc"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="Brief description of this report"
                />
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={() => void handleUpload()} disabled={uploading || !file}>
                {uploading
                  ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Uploading…</>
                  : <><Upload  className="h-4 w-4 mr-1.5" /> Upload</>}
              </Button>
              <Button
                variant="outline"
                onClick={() => { setShowUpload(false); setFile(null); setReportName(''); setDescription('') }}
                disabled={uploading}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Toolbar: search + filters + view toggle ──────────────────── */}
      {!loading && reports.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          {/* Search */}
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search reports…"
              className="pl-8 h-8 text-sm"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Tags dropdown */}
          {allTags.length > 0 && (
            <div className="relative" ref={tagsRef}>
              <Button
                variant="outline"
                size="sm"
                className={cn('h-8 gap-1.5', selectedTags.length > 0 && 'border-primary text-primary')}
                onClick={() => setTagsOpen(o => !o)}
              >
                <Tag className="h-3.5 w-3.5" />
                Tags
                {selectedTags.length > 0 && (
                  <Badge className="h-4 text-[10px] px-1.5 ml-0.5 bg-primary text-primary-foreground">
                    {selectedTags.length}
                  </Badge>
                )}
                <ChevronDown className={cn('h-3 w-3 transition-transform', tagsOpen && 'rotate-180')} />
              </Button>

              {tagsOpen && (
                <div className="absolute left-0 top-full mt-1 z-20 w-52 rounded-md border bg-popover shadow-md py-1.5">
                  <p className="px-3 py-1 text-[11px] text-muted-foreground font-medium uppercase tracking-wide">
                    Filter by tag
                  </p>
                  {allTags.map(tag => {
                    const active = selectedTags.includes(tag)
                    return (
                      <button
                        key={tag}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent transition-colors"
                        onClick={() => setSelectedTags(prev =>
                          active ? prev.filter(t => t !== tag) : [...prev, tag]
                        )}
                      >
                        <span className={cn(
                          'h-3.5 w-3.5 rounded border flex items-center justify-center flex-shrink-0',
                          active ? 'bg-primary border-primary text-primary-foreground' : 'border-input'
                        )}>
                          {active && <Check className="h-2.5 w-2.5" />}
                        </span>
                        {tag}
                      </button>
                    )
                  })}
                  {selectedTags.length > 0 && (
                    <>
                      <div className="border-t my-1" />
                      <button
                        className="w-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground text-left"
                        onClick={() => setSelectedTags([])}
                      >
                        Clear tag filters
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Source filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn('h-8 gap-1.5', source !== 'all' && 'border-primary text-primary')}
              >
                Source: {source === 'all' ? 'All' : source === 'agent' ? 'Agent' : 'Manual'}
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => setSource('all')}   className={cn(source === 'all'    && 'font-medium')}>All sources</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSource('agent')} className={cn(source === 'agent'  && 'font-medium')}>Agent generated</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSource('manual')} className={cn(source === 'manual' && 'font-medium')}>Manually uploaded</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Sort */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1.5">
                <ArrowUpDown className="h-3.5 w-3.5" />
                {SORT_LABELS[sort]}
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {(Object.keys(SORT_LABELS) as SortOption[]).map(opt => (
                <DropdownMenuItem
                  key={opt}
                  onClick={() => setSort(opt)}
                  className={cn(sort === opt && 'font-medium')}
                >
                  {SORT_LABELS[opt]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Clear filters */}
          {hasFilters && (
            <Button variant="ghost" size="sm" className="h-8 text-muted-foreground" onClick={clearFilters}>
              <X className="h-3.5 w-3.5 mr-1" /> Clear
            </Button>
          )}

          {/* Spacer + view toggle */}
          <div className="ml-auto flex items-center gap-1 border rounded-md p-0.5">
            <Button
              variant={view === 'grid' ? 'default' : 'ghost'}
              size="sm"
              className="h-6 w-7 p-0"
              onClick={() => setViewMode('grid')}
              title="Grid view"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant={view === 'table' ? 'default' : 'ghost'}
              size="sm"
              className="h-6 w-7 p-0"
              onClick={() => setViewMode('table')}
              title="Table view"
            >
              <List className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* ── Content ─────────────────────────────────────────────────────── */}
      {loading ? (
        /* Loading skeleton */
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6 space-y-3">
                <div className="h-10 w-10 rounded-lg bg-muted" />
                <div className="h-4 bg-muted rounded w-3/4" />
                <div className="h-3 bg-muted rounded w-1/2" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : reports.length === 0 ? (
        /* Empty state — no reports at all */
        <Card>
          <CardContent className="py-16 text-center">
            <BookOpen className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
            <p className="text-base font-medium text-muted-foreground">No reports yet</p>
            {isAdmin ? (
              <p className="text-sm text-muted-foreground mt-1">
                Upload your first HTML report using the button above.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground mt-1">
                Your group admins haven&apos;t uploaded any reports yet.
              </p>
            )}
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        /* Empty state — filters returned nothing */
        <Card>
          <CardContent className="py-12 text-center">
            <Search className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm font-medium text-muted-foreground">No reports match your filters</p>
            <Button variant="link" size="sm" className="mt-2 text-muted-foreground" onClick={clearFilters}>
              Clear all filters
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {/* Published section */}
          {(() => {
            const published = filtered.filter(r => r.status === 'published')
            if (published.length === 0) return null
            return (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                  <h2 className="text-sm font-semibold text-foreground">Published</h2>
                  <span className="text-xs text-muted-foreground">({published.length})</span>
                </div>
                {view === 'grid' ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {published.map(report => <ReportCard key={report.id} report={report} />)}
                  </div>
                ) : (
                  <div className="rounded-lg border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40">
                        <tr>
                          <th className="text-left py-2.5 px-3 text-xs font-medium text-muted-foreground">Name</th>
                          <th className="text-left py-2.5 px-3 text-xs font-medium text-muted-foreground">Tags</th>
                          <th className="text-left py-2.5 px-3 text-xs font-medium text-muted-foreground">Source</th>
                          <th className="text-left py-2.5 px-3 text-xs font-medium text-muted-foreground">Shared</th>
                          <th className="text-left py-2.5 px-3 text-xs font-medium text-muted-foreground">Added</th>
                          <th className="text-right py-2.5 px-3 text-xs font-medium text-muted-foreground">Actions</th>
                        </tr>
                      </thead>
                      <tbody>{published.map(report => <TableRow key={report.id} report={report} />)}</tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })()}

          {/* Drafts section */}
          {(() => {
            const drafts = filtered.filter(r => r.status !== 'published')
            if (drafts.length === 0) return null
            return (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-muted-foreground/40" />
                  <h2 className="text-sm font-semibold text-muted-foreground">Drafts</h2>
                  <span className="text-xs text-muted-foreground">({drafts.length})</span>
                </div>
                {view === 'grid' ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 opacity-90">
                    {drafts.map(report => <ReportCard key={report.id} report={report} />)}
                  </div>
                ) : (
                  <div className="rounded-lg border overflow-hidden opacity-90">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40">
                        <tr>
                          <th className="text-left py-2.5 px-3 text-xs font-medium text-muted-foreground">Name</th>
                          <th className="text-left py-2.5 px-3 text-xs font-medium text-muted-foreground">Tags</th>
                          <th className="text-left py-2.5 px-3 text-xs font-medium text-muted-foreground">Source</th>
                          <th className="text-left py-2.5 px-3 text-xs font-medium text-muted-foreground">Shared</th>
                          <th className="text-left py-2.5 px-3 text-xs font-medium text-muted-foreground">Added</th>
                          <th className="text-right py-2.5 px-3 text-xs font-medium text-muted-foreground">Actions</th>
                        </tr>
                      </thead>
                      <tbody>{drafts.map(report => <TableRow key={report.id} report={report} />)}</tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      )}

      {/* Result count */}
      {!loading && reports.length > 0 && (
        <p className="text-xs text-muted-foreground text-right">
          {filtered.length === reports.length
            ? `${reports.length} report${reports.length !== 1 ? 's' : ''}`
            : `${filtered.length} of ${reports.length} reports`}
        </p>
      )}
      </div> {/* end main content */}
    </div>
  )
}
