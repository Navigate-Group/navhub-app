import { NextResponse } from 'next/server'
import { getTrackerContext } from '@/lib/tracker/server'
import {
  buildBriefContext,
  buildBriefSystemPrompt,
  lookupProject,
  resolveAnthropicKey,
} from '@/lib/tracker/brief-server'
import {
  briefTools,
  buildProposalTurn,
  BRIEF_MODEL,
  BRIEF_MAX_STEPS,
  BRIEF_MAX_TOKENS,
  BRIEF_TIMEOUT_MS,
  type BriefMessage,
  type BriefMetrics,
  type BriefTurn,
} from '@/lib/tracker/brief'

export const runtime = 'nodejs'
export const maxDuration = 60

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

type AnthropicMessage = { role: 'user' | 'assistant'; content: unknown }

// POST /api/tracker/brief — one turn of the Briefing agent conversation.
// Body: { messages: BriefMessage[] }  (the running chat; last entry is the new
// user message). The tool loop runs on the server: the model may call
// lookup_project (read-only, as the signed-in person) any number of times up to
// the step cap, then finishes with ask_user or propose_changes. The model never
// writes to the database — applying is a separate, validated route.
export async function POST(request: Request) {
  const ctx = await getTrackerContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const { supabase, groupId } = ctx

  let body: { messages?: BriefMessage[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const incoming = Array.isArray(body.messages) ? body.messages : []
  const messages = incoming
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }))
  if (messages.length === 0) {
    return NextResponse.json({ error: 'No messages provided' }, { status: 400 })
  }

  const apiKey = await resolveAnthropicKey(groupId)
  if (!apiKey) {
    // The client shows the agreed "isn't available" message for any failure.
    return NextResponse.json({ error: 'AI service unavailable' }, { status: 503 })
  }

  const briefCtx = await buildBriefContext(supabase, groupId)
  const systemText = buildBriefSystemPrompt(briefCtx)

  // Prompt caching: the fixed part of each turn — the system instructions (which
  // include the group's people/projects/lists) and the tool definitions — is the
  // same across the tool loop and across turns, so we mark a cache breakpoint on
  // it. The system prompt is sent as a cacheable block, and the last tool carries
  // the cache_control so the whole tool array is cached up to that point. The
  // changing messages stay uncached.
  const system = [
    { type: 'text', text: systemText, cache_control: { type: 'ephemeral' } },
  ]
  const tools = briefTools.map((t, i) =>
    i === briefTools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' as const } } : t,
  )

  // Per-turn metrics (timing, model calls, tokens). Returned to the client and
  // logged on the server; never stored in the database.
  const startedAt = Date.now()
  let modelCalls = 0
  let inputTokens = 0
  let outputTokens = 0
  const metrics = (): BriefMetrics => ({
    elapsedMs: Date.now() - startedAt,
    modelCalls,
    inputTokens,
    outputTokens,
  })
  const logMetrics = (outcome: string) => {
    const m = metrics()
    console.log(
      `[tracker/brief] ${outcome} — ${m.elapsedMs}ms, ${m.modelCalls} model call(s), ` +
        `${m.inputTokens} in / ${m.outputTokens} out tokens`,
    )
  }

  // Running Anthropic message list (starts from the client's chat, then grows
  // with tool_use / tool_result turns as the loop proceeds).
  const convo: AnthropicMessage[] = messages.map((m) => ({ role: m.role, content: m.content }))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BRIEF_TIMEOUT_MS)

  try {
    for (let step = 0; step < BRIEF_MAX_STEPS; step++) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: BRIEF_MODEL,
          max_tokens: BRIEF_MAX_TOKENS,
          system,
          tools,
          messages: convo,
        }),
      })

      if (!res.ok) {
        logMetrics('ai-error')
        return NextResponse.json({ error: 'AI service error' }, { status: 503 })
      }

      modelCalls += 1
      const data = (await res.json()) as {
        content?: AnthropicContentBlock[]
        stop_reason?: string
        usage?: {
          input_tokens?: number
          output_tokens?: number
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
        }
      }
      // Count all input tokens (fresh + cache-creation + cache-read) and output.
      const u = data.usage ?? {}
      inputTokens +=
        (u.input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0)
      outputTokens += u.output_tokens ?? 0
      const blocks = Array.isArray(data.content) ? data.content : []
      const toolUses = blocks.filter(
        (b): b is Extract<AnthropicContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      )
      const text = blocks
        .filter((b): b is Extract<AnthropicContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()

      // A finishing tool (ask_user / propose_changes) ends the turn.
      const ask = toolUses.find((t) => t.name === 'ask_user')
      if (ask) {
        const q = typeof ask.input.question === 'string' ? ask.input.question : 'Could you clarify?'
        const options = Array.isArray(ask.input.options)
          ? (ask.input.options as unknown[]).filter((o): o is string => typeof o === 'string').slice(0, 8)
          : []
        const turn: BriefTurn = { type: 'question', text: q, options }
        logMetrics('question')
        return NextResponse.json({ turn, metrics: metrics() })
      }

      const propose = toolUses.find((t) => t.name === 'propose_changes')
      if (propose) {
        const turn = buildProposalTurn(propose.input, text || null)
        logMetrics('proposal')
        return NextResponse.json({ turn, metrics: metrics() })
      }

      const lookups = toolUses.filter((t) => t.name === 'lookup_project')
      if (lookups.length === 0) {
        // No tool call — plain message (or a nudge if empty).
        const turn: BriefTurn = {
          type: 'message',
          text: text || "Tell me what happened and I'll work out the changes.",
        }
        logMetrics('message')
        return NextResponse.json({ turn, metrics: metrics() })
      }

      // Resolve each lookup as the signed-in person and feed the results back.
      convo.push({ role: 'assistant', content: blocks })
      const toolResults = await Promise.all(
        lookups.map(async (t) => {
          const projectId = typeof t.input.project_id === 'string' ? t.input.project_id : ''
          const detail = projectId
            ? await lookupProject(supabase, groupId, projectId)
            : { found: false }
          return {
            type: 'tool_result' as const,
            tool_use_id: t.id,
            content: JSON.stringify(detail),
          }
        }),
      )
      convo.push({ role: 'user', content: toolResults })
    }

    // Hit the step cap without a finishing tool.
    const turn: BriefTurn = {
      type: 'message',
      text: "I couldn't work that out. Could you say it a different way?",
    }
    logMetrics('step-cap')
    return NextResponse.json({ turn, metrics: metrics() })
  } catch {
    logMetrics('exception')
    return NextResponse.json({ error: 'AI service unavailable' }, { status: 503 })
  } finally {
    clearTimeout(timer)
  }
}
