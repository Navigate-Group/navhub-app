import { NextResponse } from 'next/server'
import { getTrackerContext } from '@/lib/tracker/server'
import {
  buildBriefContext,
  buildBriefSystemPrompt,
  lookupProject,
  listOpenItems,
  findContact,
  resolveAnthropicKey,
} from '@/lib/tracker/brief-server'
import {
  briefTools,
  buildProposalTurn,
  BRIEF_MODEL,
  BRIEF_MAX_STEPS,
  BRIEF_MAX_TOKENS,
  BRIEF_TIMEOUT_MS,
  type BriefErrorReason,
  type BriefMessage,
  type BriefMetrics,
  type BriefTurn,
} from '@/lib/tracker/brief'

export const runtime = 'nodejs'
// 120s overall: BRIEF_TIMEOUT_MS (100s) caps the agent's tool loop, leaving
// ~20s of headroom for context build, key lookup and cleanup.
export const maxDuration = 120

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

type AnthropicMessage = { role: 'user' | 'assistant'; content: unknown }

// Shape of Anthropic's JSON error body: { type: 'error', error: { type, message } }.
type AnthropicErrorBody = {
  error?: { type?: string; message?: string }
}

/**
 * Return a 503 carrying the specific failure reason so the client can show the
 * right message. The reason is a coarse enum (never raw provider text or the
 * key); the real detail is logged on the server by the caller.
 */
function briefError(reason: BriefErrorReason) {
  return NextResponse.json({ error: 'AI service unavailable', reason }, { status: 503 })
}

/**
 * Classify a non-OK Anthropic response into a client-facing reason, and build a
 * one-line server log of the real cause (HTTP status + Anthropic error
 * type/message — never the API key). The response body is read as text first so
 * a non-JSON error (e.g. an HTML gateway page) still logs usefully.
 */
async function classifyAnthropicError(
  res: Response,
): Promise<{ reason: BriefErrorReason; detail: string }> {
  const status = res.status
  let errType = ''
  let errMessage = ''
  try {
    const raw = await res.text()
    try {
      const body = JSON.parse(raw) as AnthropicErrorBody
      errType = body.error?.type ?? ''
      errMessage = body.error?.message ?? ''
    } catch {
      // Non-JSON body — keep a trimmed snippet for the log.
      errMessage = raw.slice(0, 300)
    }
  } catch {
    /* no body */
  }

  // Out of credit: Anthropic returns a 400 with a credit-balance message.
  const creditHit =
    /credit balance is too low|insufficient.*credit|out of credit/i.test(errMessage) ||
    /credit/i.test(errType)
  let reason: BriefErrorReason
  if (creditHit) {
    reason = 'credit'
  } else if (status === 429 || status === 529) {
    reason = 'rate-limit'
  } else {
    reason = 'error'
  }

  const detail = `status ${status}${errType ? `, type ${errType}` : ''}${
    errMessage ? `, message ${errMessage}` : ''
  }`
  return { reason, detail }
}

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
    // Log the cause (not the config lookup details, and never a key) and tell
    // the client specifically that no key is set up for this group.
    console.error('[tracker/brief] no API key')
    return briefError('no-key')
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

  // One Anthropic call, with a single retry on 429 (rate-limited) or 529
  // (overloaded) after a short wait. Returns the OK response, or an already
  // classified failure (reason + logged detail) when it stays non-OK.
  const RETRY_WAIT_MS = 750
  const callAnthropic = async (): Promise<
    { ok: true; res: Response } | { ok: false; reason: BriefErrorReason }
  > => {
    const doFetch = () =>
      fetch('https://api.anthropic.com/v1/messages', {
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
          // Require a tool every turn, so the person always gets a confirm card,
          // a question with options, or an answer — never a bare "I will…" line.
          tool_choice: { type: 'any' },
          messages: convo,
        }),
      })

    let res = await doFetch()
    if (res.ok) return { ok: true, res }

    // Retry once on 429/529, after a brief wait, within the overall time limit.
    if (res.status === 429 || res.status === 529) {
      const first = await classifyAnthropicError(res)
      console.warn(
        `[tracker/brief] Anthropic ${first.detail} — retrying once after ${RETRY_WAIT_MS}ms`,
      )
      await new Promise((r) => setTimeout(r, RETRY_WAIT_MS))
      res = await doFetch()
      if (res.ok) return { ok: true, res }
    }

    const { reason, detail } = await classifyAnthropicError(res)
    console.error(`[tracker/brief] Anthropic error — ${detail}`)
    return { ok: false, reason }
  }

  try {
    for (let step = 0; step < BRIEF_MAX_STEPS; step++) {
      const call = await callAnthropic()
      if (!call.ok) {
        logMetrics('ai-error')
        return briefError(call.reason)
      }
      const res = call.res

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

      // A finishing tool (ask_user / propose_changes / answer) ends the turn.
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

      const answerTool = toolUses.find((t) => t.name === 'answer')
      if (answerTool) {
        const answerText =
          typeof answerTool.input.text === 'string' && answerTool.input.text.trim()
            ? answerTool.input.text.trim()
            : text || "I couldn't find anything for that."
        const turn: BriefTurn = { type: 'answer', text: answerText }
        logMetrics('answer')
        return NextResponse.json({ turn, metrics: metrics() })
      }

      // Read-only look-ups the model may call any number of times before it
      // finishes: lookup_project, list_open_items, find_contact — all as the
      // signed-in person, so RLS scopes them.
      const reads = toolUses.filter(
        (t) =>
          t.name === 'lookup_project' ||
          t.name === 'list_open_items' ||
          t.name === 'find_contact',
      )
      if (reads.length === 0) {
        // No tool call — plain message (or a nudge if empty).
        const turn: BriefTurn = {
          type: 'message',
          text: text || "Tell me what happened and I'll work out the changes.",
        }
        logMetrics('message')
        return NextResponse.json({ turn, metrics: metrics() })
      }

      // Resolve each read as the signed-in person and feed the results back.
      convo.push({ role: 'assistant', content: blocks })
      const toolResults = await Promise.all(
        reads.map(async (t) => {
          let result: unknown
          if (t.name === 'lookup_project') {
            const projectId = typeof t.input.project_id === 'string' ? t.input.project_id : ''
            result = projectId
              ? await lookupProject(supabase, groupId, projectId)
              : { found: false }
          } else if (t.name === 'list_open_items') {
            result = await listOpenItems(supabase, groupId, briefCtx.today, {
              projectId: typeof t.input.project_id === 'string' ? t.input.project_id : undefined,
              from: typeof t.input.from === 'string' ? t.input.from : undefined,
              to: typeof t.input.to === 'string' ? t.input.to : undefined,
              overdueOnly: t.input.overdueOnly === true,
            })
          } else {
            const name = typeof t.input.name === 'string' ? t.input.name : ''
            result = await findContact(supabase, groupId, name)
          }
          return {
            type: 'tool_result' as const,
            tool_use_id: t.id,
            content: JSON.stringify(result),
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
  } catch (e) {
    // The AbortController fires on BRIEF_TIMEOUT_MS: a fetch aborted that way
    // throws an AbortError. Treat that as a timeout; everything else is a
    // genuine exception. Log the real cause (type + message, never the key).
    const elapsed = Date.now() - startedAt
    const isAbort =
      (e instanceof DOMException && e.name === 'AbortError') ||
      (e instanceof Error && e.name === 'AbortError')
    if (isAbort) {
      console.error(`[tracker/brief] timeout after ${elapsed}ms`)
      logMetrics('timeout')
      return briefError('timeout')
    }
    const type = e instanceof Error ? e.name : typeof e
    const message = e instanceof Error ? e.message : String(e)
    console.error(`[tracker/brief] exception — ${type}: ${message}`)
    logMetrics('exception')
    return briefError('error')
  } finally {
    clearTimeout(timer)
  }
}
