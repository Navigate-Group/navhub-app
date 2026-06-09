import { NextResponse }    from 'next/server'
import { cookies }         from 'next/headers'
import { createClient }    from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { decrypt }         from '@/lib/encryption'
import { buildSystemPrompt, extractBrief, extractQuestion } from '@/lib/assistant'
import type { AssistantContext } from '@/lib/assistant'

interface ChatMessage {
  role:    'user' | 'assistant'
  content: string
}

interface ChatRequestBody {
  messages: ChatMessage[]
  context:  Partial<AssistantContext>   // client sends pathname + groupId hint; server enriches the rest
  isAdmin?: boolean
}

export const runtime = 'nodejs'

// ─── Server-side context builder ─────────────────────────────────────────────

async function buildAssistantContext(
  groupId:  string,
  pathname: string,
  userRole: string,
): Promise<AssistantContext> {
  const admin = createAdminClient()

  // Run all fetches in parallel
  const [
    groupRes,
    agentsRes,
    templatesRes,
    runsRes,
    companiesRes,
    docsRes,
    reportsRes,
    foldersRes,
  ] = await Promise.allSettled([
    admin.from('groups').select('name').eq('id', groupId).single(),
    admin.from('agents').select('id, name, tools, is_active').eq('group_id', groupId).eq('is_active', true),
    admin.from('report_templates').select('id, name, template_type').eq('group_id', groupId).eq('is_active', true),
    admin
      .from('agent_runs')
      .select('id, status, created_at, duration_seconds, agents!inner(name, group_id)')
      .eq('agents.group_id', groupId)
      .order('created_at', { ascending: false })
      .limit(10),
    admin.from('companies').select('id, name').eq('group_id', groupId).eq('is_active', true),
    admin
      .from('documents')
      .select('id, title, document_type, created_at')
      .eq('group_id', groupId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(5),
    admin
      .from('custom_reports')
      .select('id, name, created_at')
      .eq('group_id', groupId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(5),
    admin.from('document_folders').select('id, name').eq('group_id', groupId).eq('is_active', true),
  ])

  // ── Extract results safely ────────────────────────────────────────────────
  const groupName = groupRes.status === 'fulfilled' && groupRes.value.data
    ? (groupRes.value.data as { name: string }).name
    : 'NavHub'

  type AgentRow = { id: string; name: string; tools: string[] | null; is_active: boolean }
  const agents: AssistantContext['agents'] = agentsRes.status === 'fulfilled' && agentsRes.value.data
    ? (agentsRes.value.data as AgentRow[]).map(a => ({
        id:        a.id,
        name:      a.name,
        tools:     a.tools ?? [],
        is_active: a.is_active,
      }))
    : []

  type TemplateRow = { id: string; name: string; template_type: string }
  const templates: AssistantContext['templates'] = templatesRes.status === 'fulfilled' && templatesRes.value.data
    ? (templatesRes.value.data as TemplateRow[]).map(t => ({
        id:            t.id,
        name:          t.name,
        template_type: t.template_type,
      }))
    : []

  type RunRow = { id: string; status: string; created_at: string; duration_seconds: number | null; agents: { name: string } | { name: string }[] | null }
  const recentRuns: AssistantContext['recentRuns'] = runsRes.status === 'fulfilled' && runsRes.value.data
    ? (runsRes.value.data as unknown as RunRow[]).map(r => ({
        id:               r.id,
        agentName:        Array.isArray(r.agents) ? (r.agents[0]?.name ?? 'Unknown agent') : (r.agents?.name ?? 'Unknown agent'),
        status:           r.status,
        created_at:       r.created_at,
        duration_seconds: r.duration_seconds,
      }))
    : []

  type CompanyRow = { id: string; name: string }
  const companies: AssistantContext['companies'] = companiesRes.status === 'fulfilled' && companiesRes.value.data
    ? (companiesRes.value.data as CompanyRow[])
    : []

  type DocRow = { id: string; title: string; document_type: string; created_at: string }
  const recentDocuments: AssistantContext['recentDocuments'] = docsRes.status === 'fulfilled' && docsRes.value.data
    ? (docsRes.value.data as DocRow[])
    : []

  type ReportRow = { id: string; name: string; created_at: string }
  const recentReports: AssistantContext['recentReports'] = reportsRes.status === 'fulfilled' && reportsRes.value.data
    ? (reportsRes.value.data as ReportRow[])
    : []

  type FolderRow = { id: string; name: string }
  const folders: AssistantContext['folders'] = foldersRes.status === 'fulfilled' && foldersRes.value.data
    ? (foldersRes.value.data as FolderRow[])
    : []

  return {
    pathname,
    groupName,
    userRole,
    agents,
    templates,
    recentRuns,
    companies,
    recentDocuments,
    recentReports,
    folders,
  }
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  // Auth check
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Active group check
  const cookieStore = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  // ── Resolve API key (group → superadmin → env) ─────────────────────────────
  // Priority: 1) group_provider_configs, 2) superadmin_provider_configs, 3) env
  const admin = createAdminClient()
  let apiKey: string | undefined

  // Check group-level Anthropic config first
  const { data: groupProvRow } = await admin
    .from('group_provider_configs')
    .select('api_key_encrypted')
    .eq('group_id', activeGroupId)
    .eq('provider', 'anthropic')
    .eq('is_active', true)
    .maybeSingle()
  if (groupProvRow) {
    try { apiKey = decrypt(groupProvRow.api_key_encrypted as string) } catch { /* keep undefined */ }
  }

  // Fall back to superadmin default if group doesn't have one
  if (!apiKey) {
    const { data: superRow } = await admin
      .from('superadmin_provider_configs')
      .select('api_key_encrypted')
      .eq('provider', 'anthropic')
      .eq('is_active', true)
      .maybeSingle()
    if (superRow) {
      try { apiKey = decrypt(superRow.api_key_encrypted as string) } catch { /* keep undefined */ }
    }
  }

  // Final fallback to env
  if (!apiKey) {
    apiKey = process.env.ANTHROPIC_API_KEY
  }

  if (!apiKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })

  let body: ChatRequestBody
  try {
    body = await request.json() as ChatRequestBody
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { messages, context: clientContext, isAdmin = false } = body
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: 'No messages provided' }, { status: 400 })
  }

  // Determine user role for context (fetch from DB or use what client sent)
  const userRole = clientContext.userRole ?? 'member'
  const pathname = clientContext.pathname ?? '/'

  // Build full context server-side
  const context = await buildAssistantContext(activeGroupId, pathname, userRole)

  // ── Load assistant config from DB (platform default + group override) ────
  // The platform-level row (group_id IS NULL) is the baseline; group_id overrides
  // its non-null fields. This lets super_admins set product-wide guidance and
  // group_admins customise per-tenant persona, tone, knowledge, restrictions.
  // Loaded BEFORE buildSystemPrompt so personaName flows into the opening line.
  type CfgRow = {
    persona_name?:         string
    persona_instructions?: string | null
    scope_text?:           string | null
    knowledge_text?:       string | null
    restrictions?:         string | null
  }
  let merged: CfgRow = {}
  try {
    const [platformRes, groupRes] = await Promise.all([
      admin
        .from('assistant_config')
        .select('persona_name, persona_instructions, scope_text, knowledge_text, restrictions')
        .is('group_id', null)
        .maybeSingle(),
      admin
        .from('assistant_config')
        .select('persona_name, persona_instructions, scope_text, knowledge_text, restrictions')
        .eq('group_id', activeGroupId)
        .maybeSingle(),
    ])

    const platformCfg = (platformRes.data as CfgRow | null) ?? {}
    const groupCfg    = (groupRes.data    as CfgRow | null) ?? {}

    merged = {
      persona_name:         groupCfg.persona_name         ?? platformCfg.persona_name,
      persona_instructions: groupCfg.persona_instructions ?? platformCfg.persona_instructions,
      scope_text:           groupCfg.scope_text           ?? platformCfg.scope_text,
      knowledge_text:       groupCfg.knowledge_text       ?? platformCfg.knowledge_text,
      restrictions:         groupCfg.restrictions         ?? platformCfg.restrictions,
    }
  } catch {
    // Config table may not exist on older deployments — degrade silently.
  }

  // Inject the resolved persona name + instructions into the context so
  // buildSystemPrompt uses them in the opening line + "## How to interact" block.
  context.personaName         = merged.persona_name?.trim() || undefined
  context.personaInstructions = merged.persona_instructions?.trim() || undefined

  let systemPrompt = buildSystemPrompt(context, isAdmin)

  try {
    if (merged.knowledge_text) {
      systemPrompt += `\n\n## Additional Knowledge\n${merged.knowledge_text}`
    }
    if (merged.scope_text) {
      systemPrompt += `\n\n## Scope\n${merged.scope_text}`
    }
    if (merged.restrictions) {
      systemPrompt += `\n\n## Restrictions\n${merged.restrictions}`
    }

    const admin = createAdminClient()

    // Reference documents (platform + group level)
    const { data: knowledgeDocs } = await admin
      .from('assistant_knowledge_documents')
      .select('file_name, document_id, documents(title, content_markdown)')
      .or(`group_id.eq.${activeGroupId},group_id.is.null`)

    type KdRow = {
      file_name:   string
      document_id: string | null
      documents:   { title?: string; content_markdown?: string } | { title?: string; content_markdown?: string }[] | null
    }
    if (knowledgeDocs && knowledgeDocs.length > 0) {
      const lines = (knowledgeDocs as unknown as KdRow[]).map(d => {
        const doc     = Array.isArray(d.documents) ? d.documents[0] : d.documents
        const content = doc?.content_markdown
        return `### ${d.file_name}\n${content ? content.slice(0, 1000) : '(no content)'}`
      })
      systemPrompt += `\n\n## Reference Documents\n${lines.join('\n\n')}`
    }
  } catch {
    // Config table may not exist on older deployments — degrade silently.
  }

  // Call Anthropic API with streaming
  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system:     systemPrompt,
      messages:   messages.map(m => ({ role: m.role, content: m.content })),
      stream:     true,
    }),
  })

  if (!anthropicRes.ok) {
    const err = await anthropicRes.json().catch(() => ({})) as { error?: { message?: string } }
    return NextResponse.json(
      { error: `Anthropic API error: ${err.error?.message ?? anthropicRes.statusText}` },
      { status: 502 },
    )
  }

  const upstreamReader = anthropicRes.body?.getReader()
  if (!upstreamReader) {
    return NextResponse.json({ error: 'No response body' }, { status: 502 })
  }

  // SSE stream back to the client
  const encoder   = new TextEncoder()
  const decoder   = new TextDecoder()

  const stream = new ReadableStream({
    async start(controller) {
      let buffer   = ''
      let fullText = ''

      try {
        while (true) {
          const { done, value } = await upstreamReader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6).trim()
            if (data === '[DONE]') continue

            let event: Record<string, unknown>
            try { event = JSON.parse(data) } catch { continue }

            if (event.type === 'content_block_delta') {
              const delta = event.delta as { type?: string; text?: string }
              if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                fullText += delta.text
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: 'chunk', content: delta.text })}\n\n`,
                  ),
                )
              }
            }
          }
        }
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: 'error', message: String(err) })}\n\n`,
          ),
        )
      } finally {
        // Extract brief + question (if any) and send done event
        const { displayText: afterBrief, brief } = extractBrief(fullText)
        const { displayText, question }           = extractQuestion(afterBrief)
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type:        'done',
              brief,
              question,
              displayText: (brief || question) ? displayText : null,
            })}\n\n`,
          ),
        )
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    },
  })
}
