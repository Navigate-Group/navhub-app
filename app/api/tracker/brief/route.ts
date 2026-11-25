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
  BRIEF_MODEL,
  BRIEF_MAX_STEPS,
  BRIEF_MAX_TOKENS,
  BRIEF_TIMEOUT_MS,
  type BriefMessage,
  type BriefTurn,
  type ProposedChange,
  type ProposedChangeItem,
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
  const system = buildBriefSystemPrompt(briefCtx)

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
          tools: briefTools,
          messages: convo,
        }),
      })

      if (!res.ok) {
        return NextResponse.json({ error: 'AI service error' }, { status: 503 })
      }

      const data = (await res.json()) as {
        content?: AnthropicContentBlock[]
        stop_reason?: string
      }
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
        return NextResponse.json({ turn })
      }

      const propose = toolUses.find((t) => t.name === 'propose_changes')
      if (propose) {
        const turn = buildProposalTurn(propose.input, text || null)
        return NextResponse.json({ turn })
      }

      const lookups = toolUses.filter((t) => t.name === 'lookup_project')
      if (lookups.length === 0) {
        // No tool call — plain message (or a nudge if empty).
        const turn: BriefTurn = {
          type: 'message',
          text: text || "Tell me what happened and I'll work out the changes.",
        }
        return NextResponse.json({ turn })
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
    return NextResponse.json({ turn })
  } catch {
    return NextResponse.json({ error: 'AI service unavailable' }, { status: 503 })
  } finally {
    clearTimeout(timer)
  }
}

// ── Proposal mapping ─────────────────────────────────────────────────────────

/** Trim a possibly-missing string field; '' / non-strings become undefined. */
function s(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t === '' ? undefined : t
}
function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

/**
 * Turn the model's `propose_changes` input into typed ProposedChangeItems. Each
 * raw change is normalised to one of the known kinds; anything that doesn't have
 * the ids it needs is dropped (the apply route validates again anyway).
 */
function buildProposalTurn(input: Record<string, unknown>, fallbackIntro: string | null): BriefTurn {
  const intro = s(input.intro) ?? fallbackIntro
  const raw = Array.isArray(input.changes) ? input.changes : []
  const items: ProposedChangeItem[] = []

  raw.forEach((rc, i) => {
    if (typeof rc !== 'object' || rc === null) return
    const r = rc as Record<string, unknown>
    const kind = s(r.kind)
    const label = s(r.label) ?? 'Change'
    const change = toChange(kind, r)
    if (change) items.push({ id: `c${i}`, label, change })
  })

  return { type: 'proposal', intro, changes: items }
}

function toChange(kind: string | undefined, r: Record<string, unknown>): ProposedChange | null {
  const planId = s(r.planId)
  const status = s(r.status)
  switch (kind) {
    case 'log_update': {
      const text = s(r.text)
      if (!planId || !text) return null
      return { kind, planId, text, date: s(r.date) ?? null, source: s(r.source) ?? null }
    }
    case 'add_action': {
      const title = s(r.title)
      if (!planId || !title) return null
      return {
        kind,
        planId,
        title,
        type: s(r.type) ?? null,
        who: s(r.who) ?? null,
        assigneeId: s(r.assigneeId) ?? null,
        dueOn: s(r.dueOn) ?? null,
        milestoneId: s(r.milestoneId) ?? null,
        contactId: s(r.contactId) ?? null,
      }
    }
    case 'update_action': {
      const actionId = s(r.actionId)
      if (!actionId) return null
      const st = status === 'open' || status === 'waiting' || status === 'done' ? status : null
      return {
        kind,
        actionId,
        status: st,
        dueOn: s(r.dueOn) ?? null,
        assigneeId: s(r.assigneeId) ?? null,
        title: s(r.title) ?? null,
      }
    }
    case 'add_milestone': {
      const title = s(r.title)
      if (!planId || !title) return null
      return {
        kind,
        planId,
        title,
        status: s(r.status) ?? null,
        dueOn: s(r.dueOn) ?? null,
        progressPct: num(r.progressPct) ?? null,
      }
    }
    case 'update_milestone': {
      const milestoneId = s(r.milestoneId)
      if (!milestoneId) return null
      return {
        kind,
        milestoneId,
        status: s(r.status) ?? null,
        dueOn: s(r.dueOn) ?? null,
        progressPct: num(r.progressPct) ?? null,
      }
    }
    case 'update_plan': {
      if (!planId) return null
      const pri = s(r.priority)
      return {
        kind,
        planId,
        status: s(r.status) ?? null,
        phase: s(r.phase) ?? null,
        summary: s(r.summary) ?? null,
        priority: pri === 'high' || pri === 'normal' ? pri : null,
        progressPct: num(r.progressPct) ?? null,
        startOn: s(r.startOn) ?? null,
        endOn: s(r.endOn) ?? null,
      }
    }
    case 'add_contact': {
      const name = s(r.name)
      if (!planId || !name) return null
      return {
        kind,
        planId,
        name,
        org: s(r.org) ?? null,
        role: s(r.role) ?? null,
        phone: s(r.phone) ?? null,
        email: s(r.email) ?? null,
      }
    }
    case 'link_contact': {
      const contactId = s(r.contactId)
      if (!planId || !contactId) return null
      return { kind, planId, contactId }
    }
    case 'contacted_today': {
      const contactId = s(r.contactId)
      if (!contactId) return null
      return { kind, contactId }
    }
    default:
      return null
  }
}
