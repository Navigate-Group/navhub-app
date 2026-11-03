'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Sparkles, RefreshCw, Send, AlertTriangle, Wrench } from 'lucide-react'
import type { ExplorerView, ExplorerParams } from '@/lib/markets/explorer'
import { computeFallbackFacts, type FallbackContext } from '@/lib/markets/analyst-fallback'
import { cn } from '@/lib/utils'

/**
 * Agent Analysis panel (MKT-5). A tinted, bordered panel — green in light mode,
 * teal in dark — visually distinct from the factual explorer data beside it. It
 * renders agent analysis with word-by-word streaming, a chat interface with
 * suggested-question chips and tool visibility, and a deterministic fallback
 * facts list when the agent is disabled or fails.
 *
 * The panel is purely presentational over the data it is handed: the parent
 * passes the current ExplorerView (for fallback facts), the view params (sent to
 * the chat API so the model sees the on-screen figures) and an `onChangeView`
 * callback the `change_view` tool drives live.
 */

interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
  /** Tools the assistant invoked this turn, for visibility. */
  tools?: Array<{ name: string; summary: string }>
}

export interface AnalystPanelProps {
  /** The explorer view currently on screen — used for fallback facts. */
  view: ExplorerView
  /** The params that produced `view` — sent to the chat API. */
  viewParams: ExplorerParams
  /** Extra context for the fallback engine (sources, farm structure). */
  fallbackContext?: FallbackContext
  /** Human scope label for copy ("World", "Asia", …). */
  scopeLabel?: string
  /** Driven by the change_view tool — applies a scope/commodity/measure change live. */
  onChangeView?: (params: Partial<ExplorerParams>) => void
  className?: string
}

const MAX_TURNS = 12

function toolSummary(name: string, input: Record<string, unknown>): string {
  if (name === 'change_view') {
    const parts: string[] = []
    if (input.commodity) parts.push(String(input.commodity))
    if (input.scope) parts.push(String(input.scope))
    if (input.mapMeasure) parts.push(String(input.mapMeasure))
    return `change_view(${parts.join(', ')})`
  }
  const vals = Object.values(input).map(String).join(', ')
  return `${name}(${vals})`
}

export default function AnalystPanel({
  view,
  viewParams,
  fallbackContext,
  scopeLabel,
  onChangeView,
  className,
}: AnalystPanelProps) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])

  // Analysis state
  const [analysis, setAnalysis] = useState('')
  const [hasAnalysed, setHasAnalysed] = useState(false)

  // Chat + run state
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)

  // Load public config (enabled flag + suggestions).
  useEffect(() => {
    let active = true
    fetch('/api/markets/analyst/config')
      .then(r => r.json())
      .then(json => {
        if (!active) return
        setEnabled(Boolean(json.enabled))
        setSuggestions(Array.isArray(json.suggestions) ? json.suggestions : [])
      })
      .catch(() => { if (active) setEnabled(false) })
    return () => { active = false }
  }, [])

  // Scroll to newest on arrival.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns, analysis, streaming])

  const fallbackFacts = computeFallbackFacts(view, fallbackContext ?? {})

  /**
   * Stream a run from /api/markets/analyst/chat. `mode` is 'analysis' for the
   * headline analysis, 'chat' for a conversational turn. On a 503 fallback
   * response we surface the fallback facts (no error banner).
   */
  const runStream = useCallback(
    async (opts: {
      mode: 'analysis' | 'chat'
      messages: { role: 'user' | 'assistant'; content: string }[]
      onText: (chunk: string) => void
      onTool: (name: string, input: Record<string, unknown>) => void
    }) => {
      setError(null)
      setStreaming(true)
      try {
        const res = await fetch('/api/markets/analyst/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: opts.mode,
            messages: opts.messages,
            viewParams,
          }),
        })

        if (res.status === 503) {
          // Agent disabled / unavailable → fall back to deterministic facts.
          setEnabled(false)
          return
        }
        if (!res.ok || !res.body) {
          setError('The analyst could not be reached. Please try again.')
          return
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue
            let evt: Record<string, unknown>
            try { evt = JSON.parse(trimmed) } catch { continue }
            if (evt.type === 'text') {
              opts.onText(String(evt.content ?? ''))
            } else if (evt.type === 'tool') {
              opts.onTool(String(evt.name ?? ''), (evt.input as Record<string, unknown>) ?? {})
            } else if (evt.type === 'view') {
              onChangeView?.((evt.params as Partial<ExplorerParams>) ?? {})
            } else if (evt.type === 'error') {
              setError(String(evt.message ?? 'The analyst hit an error. Please try again.'))
            }
          }
        }
      } catch {
        setError('The analyst hit an error. Please try again.')
      } finally {
        setStreaming(false)
      }
    },
    [viewParams, onChangeView],
  )

  const runAnalysis = useCallback(async () => {
    setAnalysis('')
    setHasAnalysed(true)
    await runStream({
      mode: 'analysis',
      messages: [],
      onText: chunk => setAnalysis(prev => prev + chunk),
      onTool: () => { /* analysis does not drive tools */ },
    })
  }, [runStream])

  const sendChat = useCallback(
    async (text: string) => {
      const question = text.trim()
      if (!question || streaming) return
      setInput('')

      const priorTurns = turns
      const userTurn: ChatTurn = { role: 'user', content: question }
      setTurns(prev => [...prev, userTurn].slice(-MAX_TURNS))

      // Build the message history for the API (user+assistant pairs).
      const apiMessages = [...priorTurns, userTurn].map(t => ({ role: t.role, content: t.content }))

      let assistantContent = ''
      const assistantTools: Array<{ name: string; summary: string }> = []
      // Seed an empty assistant turn we append into as text streams.
      const seedAssistant: ChatTurn = { role: 'assistant', content: '' }
      setTurns(prev => [...prev, seedAssistant].slice(-MAX_TURNS))

      await runStream({
        mode: 'chat',
        messages: apiMessages,
        onText: chunk => {
          assistantContent += chunk
          setTurns(prev => {
            const next = [...prev]
            const last = next[next.length - 1]
            if (last && last.role === 'assistant') {
              next[next.length - 1] = { ...last, content: assistantContent, tools: assistantTools.slice() }
            }
            return next
          })
        },
        onTool: (name, inp) => {
          assistantTools.push({ name, summary: toolSummary(name, inp) })
          setTurns(prev => {
            const next = [...prev]
            const last = next[next.length - 1]
            if (last && last.role === 'assistant') {
              next[next.length - 1] = { ...last, content: assistantContent, tools: assistantTools.slice() }
            }
            return next
          })
        },
      })
    },
    [runStream, streaming, turns],
  )

  // ── Panel shell: tinted / bordered, green (light) / teal (dark) ────────────
  const shell = cn(
    'w-full rounded-xl border-2 overflow-hidden flex flex-col',
    'border-emerald-300 bg-emerald-50/70 text-emerald-950',
    'dark:border-teal-700 dark:bg-teal-950/40 dark:text-teal-50',
    'lg:w-[400px] lg:shrink-0',
    className,
  )

  return (
    <aside className={shell} aria-label="Agent analysis">
      {/* Shaded header with AI tag */}
      <header className="flex items-center gap-2 px-4 py-3 bg-emerald-100/80 dark:bg-teal-900/50 border-b-2 border-emerald-300 dark:border-teal-700">
        <Sparkles className="h-4 w-4 text-emerald-700 dark:text-teal-300" />
        <h2 className="text-sm font-semibold">Agent analysis</h2>
        <span className="ml-auto text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-200 text-emerald-800 dark:bg-teal-800 dark:text-teal-200">
          AI
        </span>
      </header>

      {/* Scrollable body */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 max-h-[60vh] lg:max-h-[640px]">
        {/* First-load prompt */}
        {!hasAnalysed && enabled !== false && (
          <div className="text-center py-6 space-y-3">
            <p className="text-sm opacity-80">
              Get an AI read on the figures for {scopeLabel ?? 'this view'}.
            </p>
            <button
              onClick={runAnalysis}
              disabled={streaming || enabled === null}
              className="inline-flex items-center gap-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium px-4 py-2 transition-colors disabled:opacity-50"
            >
              <Sparkles className="h-4 w-4" />
              Update analysis
            </button>
          </div>
        )}

        {/* Analysis output + re-run */}
        {hasAnalysed && enabled !== false && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide opacity-60">Analysis</span>
              <button
                onClick={runAnalysis}
                disabled={streaming}
                className="inline-flex items-center gap-1 text-xs opacity-70 hover:opacity-100 transition-opacity disabled:opacity-40"
                title="Re-run — bypasses the cache"
              >
                <RefreshCw className={cn('h-3 w-3', streaming && 'animate-spin')} />
                {streaming ? 'Agent thinking…' : 'Re-run'}
              </button>
            </div>
            <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:text-sm prose-headings:font-semibold prose-headings:mb-1 prose-headings:mt-3 prose-p:my-1 prose-ul:my-1 text-sm leading-relaxed">
              {analysis
                ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{analysis}</ReactMarkdown>
                : streaming
                  ? <p className="opacity-60 italic">Agent thinking…</p>
                  : <p className="opacity-60 italic">No analysis yet.</p>}
            </div>
          </div>
        )}

        {/* Fallback facts — when the agent is disabled or failed to load config */}
        {enabled === false && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide opacity-60">
              <Wrench className="h-3 w-3" />
              Computed facts
            </div>
            {fallbackFacts.length === 0 ? (
              <p className="text-sm opacity-70">No facts can be computed from the current view.</p>
            ) : (
              <ul className="space-y-2">
                {fallbackFacts.map(f => (
                  <li key={f.id} className="text-sm">
                    <span className="font-medium">{f.label}.</span>{' '}
                    <span className="opacity-90">{f.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Conversation history */}
        {turns.length > 0 && (
          <div className="space-y-3 border-t border-emerald-200 dark:border-teal-800 pt-3">
            {turns.map((t, i) => {
              // Old messages fade: only the most recent few are full-opacity.
              const fade = turns.length > 6 && i < turns.length - 6
              return (
                <div key={i} className={cn('text-sm transition-opacity', fade && 'opacity-50')}>
                  {t.role === 'user' ? (
                    <div className="flex justify-end">
                      <div className="rounded-lg rounded-br-sm bg-emerald-200/80 dark:bg-teal-800/70 px-3 py-1.5 max-w-[85%]">
                        {t.content}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {t.tools && t.tools.length > 0 && (
                        <div className="space-y-0.5">
                          {t.tools.map((tool, j) => (
                            <div key={j} className="flex items-center gap-1 text-xs opacity-70 font-mono">
                              <span className="opacity-60">→</span> {tool.summary}
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="prose prose-sm max-w-none dark:prose-invert prose-p:my-1 prose-ul:my-1">
                        {t.content
                          ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{t.content}</ReactMarkdown>
                          : <span className="opacity-60 italic">Agent thinking…</span>}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Error UX */}
        {error && (
          <div className="rounded-md border border-red-400 bg-red-50 dark:border-red-700 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p>{error}</p>
              <button
                onClick={() => (turns.length ? sendChat(turns.filter(t => t.role === 'user').slice(-1)[0]?.content ?? '') : runAnalysis())}
                className="text-xs font-medium underline hover:no-underline"
              >
                Try again
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Suggested-question chips + chat input (hidden when disabled) */}
      {enabled !== false && (
        <footer className="border-t-2 border-emerald-300 dark:border-teal-700 px-4 py-3 space-y-2 bg-emerald-100/50 dark:bg-teal-900/30">
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((s, i) => (
                <button
                  key={i}
                  onClick={() => setInput(s)}
                  disabled={streaming}
                  className="text-xs rounded-full border border-emerald-400 dark:border-teal-600 px-2.5 py-1 hover:bg-emerald-200/70 dark:hover:bg-teal-800/60 transition-colors disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <form
            onSubmit={e => { e.preventDefault(); void sendChat(input) }}
            className="flex items-end gap-2"
          >
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendChat(input) }
              }}
              rows={1}
              placeholder="Ask about this view…"
              className="flex-1 resize-none rounded-md border border-emerald-300 dark:border-teal-700 bg-white/80 dark:bg-teal-950/60 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:focus:ring-teal-500 placeholder:opacity-50"
            />
            <button
              type="submit"
              disabled={streaming || !input.trim()}
              className="shrink-0 rounded-md bg-sky-600 hover:bg-sky-500 text-white p-2 transition-colors disabled:opacity-50"
              aria-label="Send"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </footer>
      )}
    </aside>
  )
}
