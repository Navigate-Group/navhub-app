import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAnalystConfig, recordAnalystUsage } from '@/lib/markets/analyst'
import { buildExplorerView, type ExplorerParams } from '@/lib/markets/explorer'

/**
 * Market Analyst chat / analysis endpoint (MKT-5).
 * ──────────────────────────────────────────────────────────────────────────
 * POST /api/markets/analyst/chat
 *
 * Access is gated upstream by middleware (markets_viewer+). This route:
 *   - resolves the live analyst config (migration 074 override over the
 *     markets_sample.json seed);
 *   - rebuilds the on-screen ExplorerView server-side from the posted view
 *     params, so the model only ever sees the figures actually on the page
 *     (never invented data);
 *   - streams the model's answer token-by-token over SSE for the panel's
 *     word-by-word animation;
 *   - exposes a `change_view` tool so a suggestion like "Compare Asia with
 *     South America" can drive the scope control live;
 *   - records per-user token usage (best-effort);
 *   - returns 503 with `fallback: true` when the agent is disabled or the API
 *     key is missing, so the panel renders its deterministic facts instead.
 *
 * Streaming protocol (newline-delimited JSON events):
 *   {"type":"text","content":"…"}            incremental answer text
 *   {"type":"tool","name":"change_view",…}   a tool the model invoked
 *   {"type":"view","params":{…}}             the applied change_view params
 *   {"type":"done","tokens":N}               terminal success
 *   {"type":"error","message":"…"}           terminal error (panel shows retry)
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

type ChatMessage = { role: 'user' | 'assistant'; content: string }

interface ChatBody {
  mode?: 'analysis' | 'chat'
  messages?: ChatMessage[]
  viewParams?: Partial<ExplorerParams>
  /** Snapshot of the figures on screen, when the client already computed it. */
  viewSnapshot?: unknown
  /** When true, bypass any analysis cache (re-run button). */
  bypassCache?: boolean
}

const SCOPE_TOOL = {
  name: 'change_view',
  description:
    'Change the market view the user is looking at. Use ONLY when the user asks to compare or switch commodity, season, scope (a continent/region/World) or the map measure. The page re-renders with the new scope.',
  input_schema: {
    type: 'object',
    properties: {
      commodity: { type: 'string', description: 'Commodity id to switch to (optional).' },
      scope: { type: 'string', description: 'Scope id to switch to, e.g. a continent id or "WORLD" (optional).' },
      mapMeasure: {
        type: 'string',
        description: 'Map measure: production | value | exports | export_value | export_share (optional).',
      },
    },
  },
} as const

function buildSnapshot(viewParams: Partial<ExplorerParams> | undefined) {
  if (!viewParams || !viewParams.commodity) return null
  try {
    const params: ExplorerParams = {
      commodity: viewParams.commodity,
      seasons: viewParams.seasons ?? [],
      annualAverage: viewParams.annualAverage ?? false,
      valuationMethod: viewParams.valuationMethod ?? '',
      fillGaps: viewParams.fillGaps ?? true,
      scope: viewParams.scope ?? 'WORLD',
      mapMeasure: viewParams.mapMeasure ?? 'production',
    }
    const view = buildExplorerView(params)
    // Trim to the figures a business reader cares about — keeps the prompt small.
    return {
      commodity: view.about.commodityName,
      seasons: view.about.seasons,
      valuation: view.about.valuationLabel,
      gapFill: view.about.gapFill,
      cards: view.cards.map(c => ({
        measure: c.measure,
        label: c.label,
        value: c.value,
        unit: c.unit,
        counted: c.counted,
        filled: c.filled,
        shareOfWorld: c.shareOfWorld,
      })),
      rankings: view.rankings.map(r => ({
        measure: r.measure,
        label: r.label,
        total: r.total,
        rows: r.rows.slice(0, 10).map(row => ({
          name: row.name,
          value: row.value,
          share: row.share,
          filled: row.filled,
        })),
      })),
      disclaimer: view.about.disclaimer,
    }
  } catch {
    return null
  }
}

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  let body: ChatBody
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const config = await getAnalystConfig()
  const apiKey = process.env.ANTHROPIC_API_KEY

  // Agent disabled or no key → tell the panel to render fallback facts.
  if (!config.enabled) {
    return NextResponse.json({ error: 'Agent disabled', fallback: true }, { status: 503 })
  }
  if (!apiKey) {
    return NextResponse.json({ error: 'Agent unavailable', fallback: true }, { status: 503 })
  }

  const mode: 'analysis' | 'chat' = body.mode === 'analysis' ? 'analysis' : 'chat'
  const snapshot = body.viewSnapshot ?? buildSnapshot(body.viewParams)
  const systemPrompt = mode === 'analysis' ? config.analysisPrompt : config.chatPrompt

  // Compose the message list. The on-screen data is attached to the first user
  // turn so the model answers strictly from it.
  const history: ChatMessage[] = Array.isArray(body.messages) ? body.messages.slice(-24) : []
  const dataBlock = `Here is the market view currently on the user's screen (JSON). Answer only from this data and the tools available.\n\n${JSON.stringify(snapshot ?? {}, null, 0)}`

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  if (mode === 'analysis' || history.length === 0) {
    messages.push({ role: 'user', content: `${dataBlock}\n\n${mode === 'analysis' ? 'Write the market analysis now.' : (history[0]?.content ?? 'Summarise this market view.')}` })
    for (const m of history.slice(mode === 'analysis' ? 0 : 1)) messages.push(m)
  } else {
    // Prepend the data block to the first user turn; keep the rest verbatim.
    messages.push({ role: 'user', content: `${dataBlock}\n\n${history[0].content}` })
    for (const m of history.slice(1)) messages.push(m)
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))

      let inputTokens = 0
      let outputTokens = 0
      const controllerAbort = new AbortController()
      const timeout = setTimeout(() => controllerAbort.abort(), 55_000)

      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: mode === 'analysis' ? 1024 : 768,
            system: systemPrompt,
            messages,
            tools: [SCOPE_TOOL],
            stream: true,
          }),
          signal: controllerAbort.signal,
        })

        if (res.status === 429) {
          send({ type: 'error', message: 'The analyst is rate-limited. Please try again in a moment.' })
          controller.close()
          return
        }
        if (!res.ok || !res.body) {
          send({ type: 'error', message: 'The analyst could not be reached. Please try again.' })
          controller.close()
          return
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        // Tool-call accumulation (change_view).
        let toolName: string | null = null
        let toolJson = ''

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            if (payload === '[DONE]') continue
            let evt: Record<string, unknown>
            try { evt = JSON.parse(payload) } catch { continue }

            const type = evt.type as string
            if (type === 'message_start') {
              const usage = (evt.message as { usage?: { input_tokens?: number } })?.usage
              inputTokens += usage?.input_tokens ?? 0
            } else if (type === 'content_block_start') {
              const block = evt.content_block as { type?: string; name?: string }
              if (block?.type === 'tool_use') { toolName = block.name ?? null; toolJson = '' }
            } else if (type === 'content_block_delta') {
              const delta = evt.delta as { type?: string; text?: string; partial_json?: string }
              if (delta?.type === 'text_delta' && delta.text) {
                send({ type: 'text', content: delta.text })
              } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
                toolJson += delta.partial_json
              }
            } else if (type === 'content_block_stop') {
              if (toolName === 'change_view') {
                try {
                  const parsed = toolJson ? JSON.parse(toolJson) : {}
                  send({ type: 'tool', name: 'change_view', input: parsed })
                  send({ type: 'view', params: parsed })
                } catch { /* ignore malformed tool json */ }
                toolName = null
                toolJson = ''
              }
            } else if (type === 'message_delta') {
              const usage = (evt.usage as { output_tokens?: number }) ?? {}
              outputTokens += usage.output_tokens ?? 0
            }
          }
        }

        send({ type: 'done', tokens: inputTokens + outputTokens })
        controller.close()
        void recordAnalystUsage({
          userId: session.user.id,
          mode,
          model: config.model,
          inputTokens,
          outputTokens,
        })
      } catch (err) {
        const msg = (err as Error)?.name === 'AbortError'
          ? 'The analyst timed out. Please try again.'
          : 'The analyst hit an error. Please try again.'
        send({ type: 'error', message: msg })
        controller.close()
      } finally {
        clearTimeout(timeout)
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
