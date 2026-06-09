  /**
 * Agent Runner — Core Execution Engine
 * SERVER-SIDE ONLY — never import in client components.
 *
 * Orchestrates model calls, tool execution, streaming, and run persistence.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/encryption'
import {
  readFinancials,
  generateReport,
  sendSlack,
  sendEmail,
  listReportTemplates,
  readReportTemplate,
  createReportTemplate,
  updateReportTemplate,
  renderReport,
  analyseDocument,
  listDocuments,
  readDocument,
  createDocument,
  updateDocument,
  readCashflow,
  readCashflowItems,
  suggestCashflowItem,
  updateCashflowItem,
  createCashflowSnapshot,
  summariseCashflow,
  readMarketingData,
  summariseMarketing,
  readAttachment,
} from '@/lib/agent-tools'
import type {
  Agent,
  AgentModel,
  AgentTool,
  ToolCallLog,
  TaskComplexity,
} from '@/lib/types'
import { PERSONA_PRESETS as PRESETS, TASK_COMPLEXITY_SETTINGS } from '@/lib/types'

// ────────────────────────────────────────────────────────────────────────────
// Event types emitted during a run
// ────────────────────────────────────────────────────────────────────────────

export type RunEvent =
  | { type: 'text';            content: string }
  | { type: 'tool_start';      tool: string; input: Record<string, unknown> }
  | { type: 'tool_end';        tool: string; output: string }
  | { type: 'error';           message: string }
  | { type: 'done';            tokens: number }
  | { type: 'cancelled' }
  | { type: 'awaiting_input';  question: string; interaction_id: string }

export interface RunContext {
  period?:              string
  company_ids?:         string[]
  extra_instructions?:  string
}

// ────────────────────────────────────────────────────────────────────────────
// Tool definitions (Claude API format)
// ────────────────────────────────────────────────────────────────────────────

const ALL_TOOL_DEFS: Record<string, object> = {
  read_financials: {
    name:        'read_financials',
    description: 'Retrieve financial snapshot data (P&L and/or Balance Sheet) for one or more companies across specified periods.',
    input_schema: {
      type: 'object',
      properties: {
        company_ids:  { type: 'array',  items: { type: 'string' }, description: 'Company UUIDs to query. Empty array = all companies in scope.' },
        periods:      { type: 'array',  items: { type: 'string' }, description: 'Periods in YYYY-MM format, e.g. ["2026-01","2026-02"]' },
        report_types: { type: 'array',  items: { type: 'string', enum: ['profit_loss', 'balance_sheet'] }, description: 'Report types to fetch.' },
      },
      required: ['periods', 'report_types'],
    },
  },
  generate_report: {
    name:        'generate_report',
    description: 'Generate a professionally styled HTML report from markdown content and save it as a draft in the Reports Library.',
    input_schema: {
      type: 'object',
      properties: {
        title:       { type: 'string', description: 'Report title.' },
        content:     { type: 'string', description: 'Full report content in markdown.' },
        description: { type: 'string', description: 'Optional brief description of the report.' },
      },
      required: ['title', 'content'],
    },
  },
  send_slack: {
    name:        'send_slack',
    description: 'Post a message to a Slack channel via the group\'s configured webhook.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message text to send.' },
        channel: { type: 'string', description: 'Slack channel override (e.g. "#finance"). Uses agent or group default if omitted.' },
      },
      required: ['message'],
    },
  },
  send_email: {
    name:        'send_email',
    description: 'Send an email to one or more recipients via Resend.',
    input_schema: {
      type: 'object',
      properties: {
        to:               { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses.' },
        subject:          { type: 'string', description: 'Email subject.' },
        body:             { type: 'string', description: 'Email body in markdown, converted to HTML.' },
        attach_report_id: { type: 'string', description: 'Optional custom_report ID to include as a signed URL link in the email.' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  list_report_templates: {
    name:        'list_report_templates',
    description: 'List all report templates available to the current group. Returns a list where each template has a template_id field — use that value when calling read_report_template or render_report.',
    input_schema: {
      type: 'object',
      properties: {
        template_type: {
          type: 'string',
          enum: ['financial', 'matrix', 'narrative', 'dashboard', 'workflow'],
          description: 'Optional filter by type.',
        },
      },
    },
  },
  read_report_template: {
    name:        'read_report_template',
    description: 'Fetch a report template\'s definition (slots, design tokens, metadata). Scaffold HTML/CSS/JS is NOT returned by default to save tokens — the response includes scaffold_size (total chars) so you can judge whether loading it is needed. Pass include_scaffold:true only when you need to read or modify the actual scaffold code.',
    input_schema: {
      type: 'object',
      properties: {
        template_id:       { type: 'string', description: 'UUID of the template.' },
        include_scaffold:  { type: 'boolean', description: 'Set to true to include scaffold_html, scaffold_css, scaffold_js in the response. Defaults to false.' },
      },
      required: ['template_id'],
    },
  },
  create_report_template: {
    name:        'create_report_template',
    description: 'Create a new report template. Use after analysing a document or following user instructions.',
    input_schema: {
      type: 'object',
      properties: {
        name:               { type: 'string' },
        template_type:      { type: 'string', enum: ['financial', 'matrix', 'narrative', 'dashboard', 'workflow'] },
        description:        { type: 'string' },
        design_tokens:      { type: 'object', description: 'CSS variable names mapped to values.' },
        slots:              { type: 'array',  description: 'Array of slot definitions.' },
        scaffold_html:      { type: 'string', description: 'HTML scaffold with {{slot_name}} placeholders.' },
        scaffold_css:       { type: 'string', description: 'CSS with {{token_name}} placeholders.' },
        scaffold_js:        { type: 'string', description: 'Optional JavaScript.' },
        agent_instructions: { type: 'string', description: 'Instructions for future agents using this template.' },
      },
      required: ['name', 'template_type', 'slots'],
    },
  },
  update_report_template: {
    name:        'update_report_template',
    description: 'Update an existing template. Automatically saves the current version before updating.',
    input_schema: {
      type: 'object',
      properties: {
        template_id: { type: 'string' },
        changes: {
          type: 'object',
          description: 'Fields to update: name, description, design_tokens, slots, scaffold_html, scaffold_css, scaffold_js, agent_instructions.',
        },
      },
      required: ['template_id', 'changes'],
    },
  },
  render_report: {
    name:        'render_report',
    description: 'Fill a template with slot data and save to the Reports Library. REQUIRED SEQUENCE: (1) Call list_report_templates to get the template_id — never guess or assume an ID. (2) Call read_report_template with that template_id to see the slot definitions. (3) Call render_report with the template_id, slot_data matching the slot definitions, and a report_name. The template_id must be a UUID obtained from list_report_templates.',
    input_schema: {
      type: 'object',
      properties: {
        template_id: { type: 'string' },
        slot_data:   { type: 'object', description: 'Map of slot names to values.' },
        report_name: { type: 'string', description: 'Name for the saved report.' },
        notes:       { type: 'string', description: 'Optional notes.' },
      },
      required: ['template_id', 'slot_data', 'report_name'],
    },
  },
  analyse_document: {
    name:        'analyse_document',
    description: 'Analyse an uploaded document and propose a report template definition. Returns a proposal — does NOT save automatically.',
    input_schema: {
      type: 'object',
      properties: {
        file_url:     { type: 'string', description: 'URL of uploaded file in Supabase Storage or a signed URL.' },
        file_content: { type: 'string', description: 'Text content of the document if already extracted.' },
        instructions: { type: 'string', description: 'User instructions about what to extract.' },
      },
    },
  },
  list_documents: {
    name:        'list_documents',
    description: 'List documents. Use folder_type: "templates" to find template documents that can be used as structural guides.',
    input_schema: {
      type: 'object',
      properties: {
        document_type: { type: 'string', description: 'Optional filter by document type.' },
        company_id:    { type: 'string', description: 'Optional filter by company UUID.' },
        folder_id:     { type: 'string', description: 'Optional filter by folder UUID.' },
        folder_type:   { type: 'string', enum: ['general', 'templates'], description: 'Optional filter by folder type. Use "templates" to find template documents.' },
      },
    },
  },
  read_document: {
    name:        'read_document',
    description: 'Read a document from the NavHub library by ID. Large documents are returned in 20,000-character chunks. ALWAYS check has_more in the response — when true, call again with chunk: 2, 3, etc. until has_more is false. Never count entries or report completeness from a partial read.',
    input_schema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'UUID of the document.' },
        chunk:       { type: 'number', description: 'Chunk number to read (1-based). Default 1. Use when a previous response had has_more: true.' },
      },
      required: ['document_id'],
    },
  },
  create_document: {
    name:        'create_document',
    description: 'Create a new document in the NavHub Documents section. Use this to save agent-generated analysis, reports, or other content as a formal document.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        document_type: {
          type: 'string',
          enum: [
            'financial_analysis','cash_flow_review','board_report',
            'budget_vs_actual','job_description','org_structure',
            'entity_relationship','business_health','tax_position',
            'due_diligence','investor_briefing',
          ],
        },
        audience: {
          type: 'string',
          enum: ['board','management','investor','internal','hr','external'],
          description: 'Intended audience — shapes tone and depth.',
        },
        content_markdown: {
          type: 'string',
          description: 'The full markdown content of the document. Include ALL sections and content — do not truncate or summarise. Multi-page, multi-section documents are fully supported. Use headings (##), tables, bullet lists as appropriate.',
        },
        company_id: { type: 'string', description: 'Optional — associate with a specific company UUID.' },
        folder_id:  { type: 'string', description: 'Optional — save to a specific folder UUID.' },
        notes:      { type: 'string', description: 'Optional notes about this document.' },
      },
      required: ['title', 'document_type', 'audience', 'content_markdown'],
    },
  },
  update_document: {
    name:        'update_document',
    description: 'Update the content of an existing document. Automatically saves the previous version before updating.',
    input_schema: {
      type: 'object',
      properties: {
        document_id:      { type: 'string' },
        content_markdown: { type: 'string', description: 'New full document content in markdown.' },
        title:            { type: 'string', description: 'Optional new title.' },
        reason:           { type: 'string', description: 'Why this document is being updated.' },
      },
      required: ['document_id', 'content_markdown'],
    },
  },
  read_cashflow: {
    name:        'read_cashflow',
    description: 'Read the 13-week rolling cash flow forecast for a company. Returns week-by-week summary with opening/closing balances, net cash flow, and risk indicators.',
    input_schema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'UUID of the company to fetch the forecast for.' },
      },
      required: ['company_id'],
    },
  },
  read_cashflow_items: {
    name:        'read_cashflow_items',
    description: 'List the recurring and one-off cash flow line items (inflows, outflows, payables) for a company.',
    input_schema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'UUID of the company.' },
        section:    { type: 'string', enum: ['inflow', 'regular_outflow', 'payable'], description: 'Optional filter by section.' },
      },
      required: ['company_id'],
    },
  },
  suggest_cashflow_item: {
    name:        'suggest_cashflow_item',
    description: 'Suggest a new cash flow line item for human review. The item is created with pending_review=true so the user can accept or reject it.',
    input_schema: {
      type: 'object',
      properties: {
        company_id:    { type: 'string', description: 'UUID of the company.' },
        label:         { type: 'string', description: 'Human-readable name for the line item.' },
        section:       { type: 'string', enum: ['inflow', 'regular_outflow', 'payable'], description: 'Which section this item belongs to.' },
        amount:        { type: 'number', description: 'Dollar amount (not cents).' },
        recurrence:    { type: 'string', enum: ['weekly', 'fortnightly', 'monthly', 'one_off'], description: 'How often this item occurs.' },
        start_date:    { type: 'string', description: 'ISO date when this item starts (YYYY-MM-DD).' },
        end_date:      { type: 'string', description: 'Optional ISO date when this item ends (YYYY-MM-DD).' },
        day_of_week:   { type: 'number', description: 'For weekly/fortnightly: 0=Sunday … 6=Saturday.' },
        day_of_month:  { type: 'number', description: 'For monthly: day of month (1–31).' },
        reason:        { type: 'string', description: 'Why you are suggesting this item.' },
      },
      required: ['company_id', 'label', 'section', 'amount', 'recurrence', 'start_date'],
    },
  },
  update_cashflow_item: {
    name:        'update_cashflow_item',
    description: 'Update an existing cash flow item — typically to accept a pending_review item (set pending_review:false) or adjust its label/amount.',
    input_schema: {
      type: 'object',
      properties: {
        item_id:        { type: 'string', description: 'UUID of the cash flow item to update.' },
        pending_review: { type: 'boolean', description: 'Set to false to accept/approve the item.' },
        label:          { type: 'string', description: 'New label for the item.' },
        amount:         { type: 'number', description: 'New dollar amount (not cents).' },
        is_active:      { type: 'boolean', description: 'Set to false to deactivate (soft delete) the item.' },
      },
      required: ['item_id'],
    },
  },
  create_cashflow_snapshot: {
    name:        'create_cashflow_snapshot',
    description: 'Save a named snapshot of the current 13-week forecast for a company. Useful for preserving a point-in-time view before making changes.',
    input_schema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'UUID of the company.' },
        name:       { type: 'string', description: 'Name for this snapshot (e.g. "Pre-budget baseline Mar 2026").' },
        notes:      { type: 'string', description: 'Optional notes about why this snapshot was taken.' },
      },
      required: ['company_id', 'name'],
    },
  },
  summarise_cashflow: {
    name:        'summarise_cashflow',
    description: 'Generate an AI-powered executive summary of the 13-week cash flow forecast, including risks and recommendations.',
    input_schema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'UUID of the company to summarise.' },
      },
      required: ['company_id'],
    },
  },
  read_marketing_data: {
    name:        'read_marketing_data',
    description: 'Fetch marketing performance data (web, social, ads, email/CRM metrics) for one or all companies. Returns structured metric values grouped by platform and period.',
    input_schema: {
      type: 'object',
      properties: {
        company_id:  { type: 'string',                description: 'Optional: UUID of a specific company. Omit for group-wide data.' },
        platforms:   { type: 'array', items: { type: 'string' }, description: 'Optional: filter to specific platforms (e.g. ["ga4","meta"]). Omit for all platforms.' },
        period:      { type: 'string',                description: 'Optional: YYYY-MM period to fetch. Defaults to latest available.' },
        num_periods: { type: 'number',                description: 'Optional: how many past periods to include (1–12). Default 3.' },
      },
      required: [],
    },
  },
  summarise_marketing: {
    name:        'summarise_marketing',
    description: 'Generate an AI-powered executive summary of marketing performance for a specific company, including trends and recommendations.',
    input_schema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'UUID of the company to summarise marketing data for.' },
        period:     { type: 'string', description: 'Optional: YYYY-MM period to focus on. Defaults to latest available.' },
      },
      required: ['company_id'],
    },
  },
  ask_user: {
    name:        'ask_user',
    description: 'Pause the run and ask the user a clarifying question. The run will resume automatically once they respond. Use when you need specific information that is not available in your context. Keep questions concise and ask only one at a time.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user. Be specific about what information you need.' },
        context:  { type: 'string', description: 'Optional: brief explanation of why you need this information.' },
      },
      required: ['question'],
    },
  },
  read_attachment: {
    name:        'read_attachment',
    description: 'Read the content of a file attached to this agent run. For images, returns vision data. For text files, returns content. Use the file_name exactly as listed in the system prompt.',
    input_schema: {
      type: 'object',
      properties: {
        file_name: { type: 'string', description: 'The exact filename of the attachment as listed in the run context.' },
      },
      required: ['file_name'],
    },
  },
}

// ────────────────────────────────────────────────────────────────────────────
// System prompt builder
// ────────────────────────────────────────────────────────────────────────────

async function buildSystemPrompt(
  agent:        Agent,
  groupName:    string,
  context:      RunContext,
  groupId:      string,
  attachments?: Array<{ file_name: string; file_type: string }>
): Promise<string> {
  const admin   = createAdminClient()
  const today   = new Date().toISOString().split('T')[0]
  const fyStart = new Date().getMonth() >= 6
    ? new Date().getFullYear()
    : new Date().getFullYear() - 1
  const fy      = `${fyStart}–${fyStart + 1}`

  // Load company names in scope
  let companyNames = 'all companies'
  if (agent.company_scope && agent.company_scope.length > 0) {
    const { data: companies } = await admin
      .from('companies')
      .select('name')
      .in('id', agent.company_scope)
    companyNames = (companies ?? []).map((c: { name: string }) => c.name).join(', ')
  } else {
    const { data: companies } = await admin
      .from('companies')
      .select('name')
      .eq('group_id', groupId)
      .eq('is_active', true)
    companyNames = (companies ?? []).map((c: { name: string }) => c.name).join(', ') || 'none configured'
  }

  // Available periods — limit to 6 most recent to reduce system prompt size
  const { data: periods } = await admin
    .from('financial_snapshots')
    .select('period')
    .eq('report_type', 'profit_loss')
    .order('period', { ascending: false })
    .limit(6)
  const periodList = (periods ?? [])
    .map((p: { period: string }) => p.period)
    .filter((p: string, i: number, a: string[]) => a.indexOf(p) === i)
    .join(', ') || 'none available'

  const personaText = agent.persona_preset !== 'custom'
    ? PRESETS[agent.persona_preset as keyof typeof PRESETS]
    : (agent.persona ?? '')

  // Communication style guidance
  const commStyle = (agent.communication_style as string | undefined) ?? 'balanced'
  const styleText = commStyle === 'formal'
    ? 'Communicate in a formal, professional tone. Use precise language suitable for executive audiences.'
    : commStyle === 'casual'
    ? 'Use a friendly, conversational tone. Keep language approachable and avoid unnecessary jargon.'
    : '' // balanced = no special instruction

  // Response length guidance
  const respLength = (agent.response_length as string | undefined) ?? 'balanced'
  const lengthText = respLength === 'concise'
    ? 'Keep responses concise and to the point. Include only the key facts and recommendations.'
    : respLength === 'detailed'
    ? 'Provide thorough, detailed responses with full context, reasoning, and explanation.'
    : '' // balanced = no special instruction

  // ── Knowledge base injection ───────────────────────────────────────────
  const knowledgeParts: string[] = []

  // Universal (group-level) knowledge — loaded first, lower priority than
  // agent-specific knowledge. Migration 042.
  try {
    const { data: univ } = await admin
      .from('group_agent_knowledge')
      .select('knowledge_text, knowledge_links')
      .eq('group_id', groupId)
      .maybeSingle()

    const univDocsP = admin
      .from('group_agent_knowledge_documents')
      .select('file_name, document_id, documents(title, content_markdown)')
      .eq('group_id', groupId)
    const { data: univDocs } = await univDocsP

    const univText  = univ?.knowledge_text as string | null | undefined
    const univLinks = (univ?.knowledge_links ?? []) as Array<{ url: string; label?: string }>

    if (univText || univLinks.length > 0 || (univDocs && univDocs.length > 0)) {
      const sections: string[] = ['\n## Universal Company Knowledge',
        'The following is foundational context about the organisation.',
        'Use this as background — agent-specific knowledge and run instructions take precedence.']
      if (univText) sections.push(`\n${univText}`)
      if (univLinks.length > 0) {
        sections.push('\nReference Links:')
        sections.push(univLinks.map(l => `- ${l.label ?? l.url}: ${l.url}`).join('\n'))
      }
      if (univDocs && univDocs.length > 0) {
        sections.push('\nReference Documents:')
        const lines = (univDocs as Array<{ file_name: string; document_id: string | null; documents: { title?: string; content_markdown?: string } | null }>).map(d => {
          const md = d.documents?.content_markdown
          const title = d.documents?.title ?? d.file_name
          return `### ${title}\n${md ? md.slice(0, 800) + (md.length > 800 ? '…' : '') : '(no extracted content)'}`
        })
        sections.push(lines.join('\n\n'))
      }
      knowledgeParts.push(sections.join('\n'))
    }
  } catch { /* silently degrade */ }

  if (agent.knowledge_text) {
    knowledgeParts.push(`\nBackground Knowledge:\n${agent.knowledge_text}`)
  }

  const kLinks = (agent.knowledge_links ?? []) as Array<{ url: string; label?: string }>
  if (kLinks.length > 0) {
    const linkLines = kLinks.map(l => `- ${l.label ?? l.url}: ${l.url}`).join('\n')
    knowledgeParts.push(`\nReference Links:\n${linkLines}`)
  }

  // Knowledge documents + reports — fetch and include content summaries
  if (agent.id) {
    try {
      type KDocRow = { file_name: string; document_id: string | null; report_id: string | null }
      const { data: kDocsRaw } = await admin
        .from('agent_knowledge_documents')
        .select('file_name, document_id, report_id')
        .eq('agent_id', agent.id)
      const kDocs = (kDocsRaw ?? []) as KDocRow[]

      if (kDocs.length > 0) {
        // ── Fetch document content_markdown in one batch ──
        const docIds = kDocs.map(kd => kd.document_id).filter((id): id is string => !!id)
        let docContents: Record<string, string> = {}
        if (docIds.length > 0) {
          const { data: docs } = await admin
            .from('documents')
            .select('id, content_markdown')
            .in('id', docIds)
          if (docs) {
            docContents = (docs as Array<{ id: string; content_markdown: string | null }>)
              .reduce((acc, d) => {
                if (d.content_markdown) acc[d.id] = d.content_markdown
                return acc
              }, {} as Record<string, string>)
          }
        }

        // ── Fetch report HTML from Storage in parallel ──
        // custom_reports has no `content` column — HTML lives in Storage at file_path.
        // Strip tags down to plain text and slice to ~1500 chars.
        const reportIds = kDocs.map(kd => kd.report_id).filter((id): id is string => !!id)
        const reportContents: Record<string, string> = {}
        if (reportIds.length > 0) {
          const { data: reports } = await admin
            .from('custom_reports')
            .select('id, file_path')
            .in('id', reportIds)
          const fetches = (reports ?? [])
            .filter((r: { file_path: string | null }) => !!r.file_path)
            .map(async (r: { id: string; file_path: string | null }) => {
              try {
                const dl = await admin.storage.from('report-files').download(r.file_path as string)
                if (!dl.data) return
                const text = await dl.data.text()
                // Strip HTML tags + collapse whitespace, slice to 1500 chars
                const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
                reportContents[r.id] = plain.slice(0, 1500)
              } catch { /* ignore individual report download failures */ }
            })
          await Promise.all(fetches)
        }

        const summaries = kDocs.map(kd => {
          if (kd.report_id) {
            const c = reportContents[kd.report_id]
            return `- 📊 ${kd.file_name} (report): ${c ? c + '…' : '(content not available)'}`
          }
          const c = kd.document_id ? docContents[kd.document_id] : null
          return `- ${kd.file_name}: ${c ? c.slice(0, 500) + '…' : '(no extracted content)'}`
        }).join('\n')
        knowledgeParts.push(`\nKnowledge Documents:\n${summaries}`)
      }
    } catch { /* ignore knowledge doc fetch errors */ }
  }

  return [
    `You are ${agent.name}, an AI agent for ${groupName}.`,
    personaText ? `\n${personaText}` : '',
    styleText   ? `\nStyle: ${styleText}` : '',
    lengthText  ? `\nDepth: ${lengthText}` : '',
    agent.instructions ? `\nYour task: ${agent.instructions}` : '',
    '\nContext:',
    `* Current date: ${today}`,
    `* Financial year: July–June (Australian FY${fy})`,
    `* Active group: ${groupName}`,
    `* Companies in scope: ${companyNames}`,
    context.period ? `* Current period: ${context.period}` : '',
    '\nAvailable data:',
    `* Financial periods available: ${periodList}`,
    ...knowledgeParts,
    context.extra_instructions ? `\nAdditional instructions: ${context.extra_instructions}` : '',
    attachments && attachments.length > 0
      ? `\nAttached files for this run (call read_attachment with the EXACT file_name shown in quotes — do NOT append the type):\n${attachments.map(a => `• "${a.file_name}"  [type: ${a.file_type}]`).join('\n')}`
      : '',
    '\nCRITICAL TOOL SEQUENCING RULES:',
    '* NEVER call read_report_template without first calling list_report_templates to obtain the template_id',
    '* NEVER call render_report without first calling list_report_templates AND read_report_template',
    '* NEVER assume, guess, or hardcode a template_id — always look it up via list_report_templates first',
    '* list_report_templates returns template_id fields — copy the exact UUID value into subsequent calls',
    '* If you think you know the template_id, you are wrong — always call list_report_templates first',
    '* Use ask_user when you need specific information from the user (e.g. which company, which period, preferred format). Ask one concise question at a time. The user will reply and the run will continue automatically.',
  ].filter(Boolean).join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// Credential loader
// ────────────────────────────────────────────────────────────────────────────

async function loadCredentials(agentId: string): Promise<Record<string, string>> {
  const admin = createAdminClient()

  const { data: creds } = await admin
    .from('agent_credentials')
    .select('key, value')
    .eq('agent_id', agentId)
    .eq('is_active', true)

  const result: Record<string, string> = {}
  for (const cred of (creds ?? []) as Array<{ key: string; value: string }>) {
    try {
      result[cred.key] = decrypt(cred.value)
    } catch {
      // Skip credentials that fail to decrypt
    }
  }
  return result
}

// ────────────────────────────────────────────────────────────────────────────
// Skills loader — pulls platform / group / agent skills into a single
// system-prompt block plus a flat list of granted tool names.
// ────────────────────────────────────────────────────────────────────────────

interface LoadedSkill {
  name:           string
  instructions:   string
  knowledge_text: string | null
  examples:       string | null
  tool_grants:    string[]
  skill_knowledge_documents?: Array<{
    file_name: string
    documents?: { content_markdown?: string | null } | null
  }>
}

interface SkillsBundle {
  promptBlock: string
  toolGrants:  string[]
}

function buildSkillBlock(skill: LoadedSkill): string {
  const lines: string[] = [`### Skill: ${skill.name}`, skill.instructions.trim()]
  if (skill.knowledge_text && skill.knowledge_text.trim()) {
    lines.push(`\n**Knowledge:**\n${skill.knowledge_text.trim()}`)
  }
  for (const doc of skill.skill_knowledge_documents ?? []) {
    const content = doc.documents?.content_markdown
    if (content && content.trim()) {
      // Clamp each reference doc to ~2000 chars to keep prompts manageable.
      lines.push(`\n**Reference — ${doc.file_name}:**\n${content.slice(0, 2000)}`)
    }
  }
  if (skill.examples && skill.examples.trim()) {
    lines.push(`\n**Examples:**\n${skill.examples.trim()}`)
  }
  return lines.join('\n')
}

function toolNameAlreadyPresent(defs: Array<Record<string, unknown>>, name: string): boolean {
  return defs.some(d => (d as { name?: string }).name === name)
}

async function loadSkillsForRun(
  agentId: string,
  groupId: string,
  admin:   ReturnType<typeof createAdminClient>,
): Promise<SkillsBundle> {
  const SKILL_SELECT = `
    id, name, instructions, knowledge_text, examples, tool_grants,
    skill_knowledge_documents(file_name, document_id, documents(content_markdown))
  `

  // Platform — every published, active platform skill.
  const platformQ = admin
    .from('skills')
    .select(SKILL_SELECT)
    .eq('tier', 'platform')
    .eq('is_published', true)
    .eq('is_active',    true)
    .order('created_at', { ascending: true })

  // Group — assigned to this group via group_skills.
  const groupQ = admin
    .from('group_skills')
    .select(`sort_order, skills(${SKILL_SELECT})`)
    .eq('group_id', groupId)
    .order('sort_order', { ascending: true })

  // Agent — assigned to this agent via agent_skills.
  const agentQ = admin
    .from('agent_skills')
    .select(`sort_order, skills(${SKILL_SELECT})`)
    .eq('agent_id', agentId)
    .order('sort_order', { ascending: true })

  const [{ data: platformSkills }, { data: groupRows }, { data: agentRows }] =
    await Promise.all([platformQ, groupQ, agentQ])

  const groupSkills = ((groupRows ?? []) as Array<{ skills: LoadedSkill | LoadedSkill[] | null }>)
    .flatMap(r => Array.isArray(r.skills) ? r.skills : (r.skills ? [r.skills] : []))
  const agentSkills = ((agentRows ?? []) as Array<{ skills: LoadedSkill | LoadedSkill[] | null }>)
    .flatMap(r => Array.isArray(r.skills) ? r.skills : (r.skills ? [r.skills] : []))

  // Filter out inactive group/agent skills (RLS allows reading all tiers,
  // but we only want active ones in the prompt).
  const activeGroupSkills = groupSkills.filter(s => (s as LoadedSkill & { is_active?: boolean }).is_active !== false)
  const activeAgentSkills = agentSkills.filter(s => (s as LoadedSkill & { is_active?: boolean }).is_active !== false)

  const all: LoadedSkill[] = [
    ...((platformSkills ?? []) as LoadedSkill[]),
    ...activeGroupSkills,
    ...activeAgentSkills,
  ]

  if (all.length === 0) return { promptBlock: '', toolGrants: [] }

  const blocks = all.map(buildSkillBlock)
  const promptBlock = [
    '## Your Skills and Expertise',
    'The following skills define your expertise and how you approach tasks. Apply them automatically — users do not need to instruct you to use them.',
    '',
    blocks.join('\n\n'),
  ].join('\n')

  // Dedupe tool grants across all skill tiers.
  const toolGrantSet = new Set<string>()
  for (const skill of all) {
    for (const t of (skill.tool_grants ?? [])) {
      if (typeof t === 'string' && t.length > 0) toolGrantSet.add(t)
    }
  }

  return {
    promptBlock,
    toolGrants: Array.from(toolGrantSet),
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ask_user handler — pauses run and waits for user reply (up to 10 minutes)
// ────────────────────────────────────────────────────────────────────────────

async function handleAskUser(
  question: string,
  runId:    string,
  onChunk:  (event: RunEvent) => void
): Promise<string> {
  const admin = createAdminClient()

  // 1. Insert interaction record
  const { data: interaction, error } = await admin
    .from('agent_run_interactions')
    .insert({ run_id: runId, question })
    .select('id')
    .single()

  if (error || !interaction) {
    return `Error creating interaction: ${error?.message ?? 'unknown'}`
  }

  const interactionId = (interaction as { id: string }).id

  // 2. Set run to awaiting_input
  await admin
    .from('agent_runs')
    .update({
      status:                  'awaiting_input',
      awaiting_input_question: question,
      awaiting_input_at:       new Date().toISOString(),
    })
    .eq('id', runId)

  // 3. Emit SSE event so UI can show reply card
  onChunk({ type: 'awaiting_input', question, interaction_id: interactionId })

  // 4. Poll every 2s for up to 10 minutes
  const maxWaitMs = 10 * 60 * 1_000
  const pollMs    = 2_000
  const deadline  = Date.now() + maxWaitMs

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs))

    // Check cancellation first
    const { data: cancelCheck } = await admin
      .from('agent_runs')
      .select('cancellation_requested')
      .eq('id', runId)
      .single()
    if (cancelCheck?.cancellation_requested) {
      return '__CANCELLED__'
    }

    // Check for answer
    const { data: row } = await admin
      .from('agent_run_interactions')
      .select('answer, answered_at')
      .eq('id', interactionId)
      .single()

    if (row?.answered_at && row.answer !== null) {
      // Restore run status to running
      await admin
        .from('agent_runs')
        .update({
          status:                  'running',
          awaiting_input_question: null,
          awaiting_input_at:       null,
        })
        .eq('id', runId)
      return (row as { answer: string }).answer
    }
  }

  // Timed out — treat as cancelled
  return '__CANCELLED__'
}

// ────────────────────────────────────────────────────────────────────────────
// Anthropic Claude API call (streaming)
// ────────────────────────────────────────────────────────────────────────────

interface AnthropicMessage {
  role:    'user' | 'assistant'
  content: string | AnthropicContent[]
}

interface AnthropicContent {
  type:        string
  id?:         string
  name?:       string
  input?:      unknown
  tool_use_id?: string
  content?:    string | Array<{ type: string; text?: string }>
  text?:       string
}

interface ToolUseBlock {
  id:    string
  name:  string
  input: Record<string, unknown>
}

interface ModelResponse {
  text:       string
  tool_calls: ToolUseBlock[]
  tokens:     number
}

async function callClaude(
  model:        AgentModel,
  messages:     AnthropicMessage[],
  tools:        object[],
  systemPrompt: string,
  onChunk:      (chunk: string) => void,
  credentials?: Record<string, string>,
  maxTokens?:   number,
  isCancelled?: () => Promise<boolean>
): Promise<ModelResponse> {
  // Use BYO key from agent credentials if available, fall back to env var
  const apiKey = credentials?.['anthropic_api_key'] ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable not set')

  // ── Bulletproof timer + abort plumbing ──────────────────────────────────
  // Earlier implementations had every exit path leak at least one timer or
  // miss clearing the connect timer in error branches, which is how some
  // production runs ended up hung for hours. This block keeps a single
  // closure-scoped controller and explicit clearTimers() called from every
  // exit (success, error, abort, rate-limit) inside one big try/finally.
  const controller = new AbortController()
  const { signal } = controller

  const CONNECT_TIMEOUT_MS = 45_000
  const IDLE_TIMEOUT_MS    = 60_000

  let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    console.error(`[callClaude] connect timeout — aborting after ${CONNECT_TIMEOUT_MS}ms`)
    try { controller.abort() } catch { /* ignore */ }
  }, CONNECT_TIMEOUT_MS)

  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      console.error(`[callClaude] idle timeout — no chunk for ${IDLE_TIMEOUT_MS}ms`)
      try { controller.abort() } catch { /* ignore */ }
    }, IDLE_TIMEOUT_MS)
  }

  const clearTimers = () => {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
    if (idleTimer)    { clearTimeout(idleTimer);    idleTimer    = null }
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens ?? 16_000,
    system:     systemPrompt,
    messages,
    stream:     true,
  }
  if (tools.length > 0) body.tools = tools

  let res: Response
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body:   JSON.stringify(body),
      signal,
    })

    // Headers received — kill the connect timer immediately.
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
  } catch (err) {
    clearTimers()
    if (signal.aborted) throw new Error('callClaude aborted: connect-timeout')
    throw err
  }

  // Handle rate limiting BEFORE attempting to read the body — propagate as a
  // distinguishable error so executeAgentRun can sleep + retry rather than
  // marking the run failed.
  if (res.status === 429) {
    const retryHdr   = res.headers.get('retry-after')
    const retryAfter = retryHdr ? parseInt(retryHdr, 10) : 10
    clearTimers()
    console.warn(`[callClaude] rate limited (429) — retry after ${retryAfter}s`)
    throw new Error(`RATE_LIMITED:${Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 10}`)
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
    clearTimers()
    throw new Error(`Anthropic API error ${res.status}: ${err.error?.message ?? 'Unknown'}`)
  }

  const reader = res.body?.getReader()
  if (!reader) {
    clearTimers()
    throw new Error('No response body from Anthropic API')
  }

  // Start idle watchdog now that we own the stream.
  resetIdle()

  let fullText  = ''
  const toolUses: ToolUseBlock[] = []
  let inputTokens = 0
  let outputTokens = 0

  const decoder = new TextDecoder()
  let buffer    = ''
  let chunkCount = 0

  try {
    while (true) {
      let read: ReadableStreamReadResult<Uint8Array>
      try {
        read = await reader.read()
      } catch (err) {
        // reader.read() can throw if the underlying stream is aborted.
        if (signal.aborted) {
          throw new Error(signal.reason
            ? `callClaude aborted: ${String(signal.reason)}`
            : 'callClaude aborted: idle-timeout')
        }
        throw err
      }
      if (read.done) break
      // Reset idle watchdog on every successful read — this is the critical
      // anti-hang guarantee. Even if the parsed SSE event yields no text,
      // the bytes still landed.
      resetIdle()

      // Mid-stream cancellation poll — every 20 reads.
      chunkCount++
      if (isCancelled && chunkCount % 20 === 0) {
        try {
          if (await isCancelled()) {
            try { controller.abort() } catch { /* ignore */ }
            throw new Error('CANCELLED_MID_STREAM')
          }
        } catch (err) {
          if (err instanceof Error && err.message === 'CANCELLED_MID_STREAM') throw err
          // DB blip — ignore, iteration-boundary check is the safety net
        }
      }

      buffer += decoder.decode(read.value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue

        let event: Record<string, unknown>
        try { event = JSON.parse(data) } catch { continue }

        const evType = event.type as string

        if (evType === 'content_block_start') {
          const block = event.content_block as Record<string, unknown>
          if (block.type === 'tool_use') {
            toolUses.push({
              id:    block.id as string,
              name:  block.name as string,
              input: {},
            })
          }
        } else if (evType === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown>
          if (delta.type === 'text_delta') {
            const chunk = delta.text as string
            fullText += chunk
            onChunk(chunk)
          } else if (delta.type === 'input_json_delta' && toolUses.length > 0) {
            const last = toolUses[toolUses.length - 1]
            const existing = (last.input as Record<string, unknown>).__raw ?? ''
            last.input = { __raw: (existing as string) + (delta.partial_json as string ?? '') }
          }
        } else if (evType === 'message_delta') {
          const usage = event.usage as Record<string, number> | undefined
          if (usage) outputTokens = usage.output_tokens ?? 0
        } else if (evType === 'message_start') {
          const msg = event.message as Record<string, unknown>
          const usage = msg?.usage as Record<string, number> | undefined
          if (usage) inputTokens = usage.input_tokens ?? 0
        }
      }
    }
  } finally {
    clearTimers()
    try { reader.releaseLock() } catch { /* already released */ }
  }

  // Parse accumulated tool inputs
  for (const tu of toolUses) {
    const raw = (tu.input as Record<string, unknown>).__raw as string | undefined
    if (raw) {
      try { tu.input = JSON.parse(raw) } catch { tu.input = {} }
    }
  }

  return { text: fullText, tool_calls: toolUses, tokens: inputTokens + outputTokens }
}

// ────────────────────────────────────────────────────────────────────────────
// GPT-4o API call (streaming)
// ────────────────────────────────────────────────────────────────────────────

async function callGPT4o(
  messages:     AnthropicMessage[],
  tools:        object[],
  systemPrompt: string,
  credentials:  Record<string, string>,
  onChunk:      (chunk: string) => void
): Promise<ModelResponse> {
  const apiKey = credentials['OPENAI_API_KEY']
  if (!apiKey) throw new Error('OPENAI_API_KEY credential not configured for this agent')

  // Convert messages to OpenAI format
  const oaiMessages: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }]
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      oaiMessages.push({ role: msg.role, content: msg.content })
    } else {
      // Flatten content blocks
      const textContent = (msg.content as AnthropicContent[])
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join('\n')
      oaiMessages.push({ role: msg.role, content: textContent })
    }
  }

  // Convert tools to OpenAI function format
  const oaiTools = tools.map((t: object) => {
    const tool = t as Record<string, unknown>
    return {
      type:     'function',
      function: {
        name:        tool.name,
        description: tool.description,
        parameters:  tool.input_schema,
      },
    }
  })

  const body: Record<string, unknown> = {
    model:    'gpt-4o',
    messages: oaiMessages,
    stream:   true,
  }
  if (oaiTools.length > 0) body.tools = oaiTools

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
    throw new Error(`OpenAI API error ${res.status}: ${err.error?.message ?? 'Unknown'}`)
  }

  let fullText   = ''
  const toolCalls: ToolUseBlock[] = []
  let totalTokens = 0

  const reader  = res.body?.getReader()
  if (!reader) throw new Error('No response body from OpenAI API')

  const decoder = new TextDecoder()
  let buffer    = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') continue

      let chunk: Record<string, unknown>
      try { chunk = JSON.parse(data) } catch { continue }

      const choice = (chunk.choices as Array<Record<string, unknown>>)?.[0]
      if (!choice) continue

      const delta = choice.delta as Record<string, unknown>
      if (delta.content) {
        fullText += delta.content as string
        onChunk(delta.content as string)
      }

      // Tool calls
      const tcDeltas = delta.tool_calls as Array<Record<string, unknown>> | undefined
      if (tcDeltas) {
        for (const tc of tcDeltas) {
          const idx = tc.index as number
          while (toolCalls.length <= idx) {
            toolCalls.push({ id: '', name: '', input: {} })
          }
          const fn = tc.function as Record<string, unknown> | undefined
          if (fn?.name) toolCalls[idx].name = fn.name as string
          if (fn?.arguments) {
            const existing = (toolCalls[idx].input as Record<string, unknown>).__raw ?? ''
            toolCalls[idx].input = { __raw: (existing as string) + (fn.arguments as string) }
          }
          if (tc.id) toolCalls[idx].id = tc.id as string
        }
      }

      const usage = chunk.usage as Record<string, number> | undefined
      if (usage) totalTokens = usage.total_tokens ?? 0
    }
  }

  // Parse tool call JSON
  for (const tc of toolCalls) {
    const raw = (tc.input as Record<string, unknown>).__raw as string | undefined
    if (raw) {
      try { tc.input = JSON.parse(raw) } catch { tc.input = {} }
    }
  }

  return { text: fullText, tool_calls: toolCalls, tokens: totalTokens }
}

// ────────────────────────────────────────────────────────────────────────────
// Tool dispatcher
// ────────────────────────────────────────────────────────────────────────────

async function executeTool(
  toolName:    AgentTool,
  input:       Record<string, unknown>,
  agent:       Agent,
  groupId:     string,
  groupName:   string,
  runId:       string,
  credentials: Record<string, string>
): Promise<string> {
  const admin = createAdminClient()
  const { data: runRecord } = await admin
  .from('agent_runs')
  .select('output_folder_id, output_status, output_name_override, output_type')
  .eq('id', runId)
  .single()

  const context = { agent, groupId, groupName, runId, credentials, run: runRecord ?? undefined }

  switch (toolName) {
    case 'read_financials':
      return readFinancials(input as unknown as Parameters<typeof readFinancials>[0], context)
    case 'generate_report':
      return generateReport(input as unknown as Parameters<typeof generateReport>[0], context)
    case 'send_slack':
      return sendSlack(input as unknown as Parameters<typeof sendSlack>[0], context)
    case 'send_email':
      return sendEmail(input as unknown as Parameters<typeof sendEmail>[0], context)
    case 'list_report_templates':
      return listReportTemplates(input as unknown as Parameters<typeof listReportTemplates>[0], context)
    case 'read_report_template':
      return readReportTemplate(input as unknown as Parameters<typeof readReportTemplate>[0], context)
    case 'create_report_template':
      return createReportTemplate(input as unknown as Parameters<typeof createReportTemplate>[0], context)
    case 'update_report_template':
      return updateReportTemplate(input as unknown as Parameters<typeof updateReportTemplate>[0], context)
    case 'render_report':
      return renderReport(input as unknown as Parameters<typeof renderReport>[0], context)
    case 'analyse_document':
      return analyseDocument(input as unknown as Parameters<typeof analyseDocument>[0])
    case 'list_documents':
      return listDocuments(input as unknown as Parameters<typeof listDocuments>[0], context)
    case 'read_document':
      return readDocument(input as unknown as Parameters<typeof readDocument>[0], context)
    case 'create_document':
      return createDocument(input as unknown as Parameters<typeof createDocument>[0], context)
    case 'update_document':
      return updateDocument(input as unknown as Parameters<typeof updateDocument>[0], context)
    case 'read_cashflow':
      return readCashflow(input as unknown as Parameters<typeof readCashflow>[0], context)
    case 'read_cashflow_items':
      return readCashflowItems(input as unknown as Parameters<typeof readCashflowItems>[0], context)
    case 'suggest_cashflow_item':
      return suggestCashflowItem(input as unknown as Parameters<typeof suggestCashflowItem>[0], context)
    case 'update_cashflow_item':
      return updateCashflowItem(input as unknown as Parameters<typeof updateCashflowItem>[0], context)
    case 'create_cashflow_snapshot':
      return createCashflowSnapshot(input as unknown as Parameters<typeof createCashflowSnapshot>[0], context)
    case 'summarise_cashflow':
      return summariseCashflow(input as unknown as Parameters<typeof summariseCashflow>[0], context)
    case 'read_marketing_data':
      return readMarketingData(input as unknown as Parameters<typeof readMarketingData>[0], context)
    case 'summarise_marketing':
      return summariseMarketing(input as unknown as Parameters<typeof summariseMarketing>[0], context)
    case 'read_attachment':
      return readAttachment(input as unknown as Parameters<typeof readAttachment>[0], context)
    case 'ask_user':
      // Handled specially in executeAgentRun — should never reach executeTool
      return 'ask_user is handled by the runner directly.'
    default: {
      // Custom webhook tool (created via Settings → Agents → Custom Tools)
      const admin = createAdminClient()
      const { data: customTool } = await admin
        .from('custom_tools')
        .select('webhook_url, http_method, headers')
        .eq('group_id', groupId)
        .eq('name', toolName)
        .eq('is_active', true)
        .maybeSingle()

      if (customTool) {
        try {
          const headers = {
            'Content-Type': 'application/json',
            ...((customTool.headers ?? {}) as Record<string, string>),
          }
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 30_000)
          const requestInit: RequestInit = {
            method:  customTool.http_method,
            headers,
            signal:  controller.signal,
          }
          if (customTool.http_method !== 'GET') {
            requestInit.body = JSON.stringify(input ?? {})
          }
          const res = await fetch(customTool.webhook_url, requestInit)
          clearTimeout(timer)

          const contentType = res.headers.get('content-type') ?? ''
          let body: unknown
          if (contentType.includes('application/json')) {
            try { body = await res.json() } catch { body = null }
          } else {
            body = (await res.text()).slice(0, 4000)
          }
          return JSON.stringify({ status: res.status, ok: res.ok, response: body })
        } catch (err) {
          return JSON.stringify({ error: `Custom tool "${toolName}" failed: ${String(err)}` })
        }
      }

      // Web search (stub — real implementation would call an external search API)
      if (toolName === 'web_search') {
        return JSON.stringify({
          error: 'Web search tool is enabled but the server-side search provider is not yet configured. Ask an admin to set up the search integration.',
        })
      }

      return `Unknown tool: ${toolName}`
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Notifications
// ────────────────────────────────────────────────────────────────────────────

interface RunForNotify {
  id:                   string
  status:               string
  run_name?:            string | null
  output_document_id?:  string | null
  draft_report_id?:     string | null
  notify_email?:        string | null
  notify_slack_channel?: string | null
}

interface AgentForNotify {
  name:                 string
  notify_on_completion?: boolean
  notify_on_output?:     boolean
  notify_email?:         string | null
  notify_slack_channel?: string | null
}

async function sendRunNotifications(
  run:     RunForNotify,
  agent:   AgentForNotify,
  groupId: string,
): Promise<void> {
  try {
    const emailTo   = run.notify_email         ?? agent.notify_email         ?? null
    const slackChan = run.notify_slack_channel ?? agent.notify_slack_channel ?? null

    const hasOutput               = !!(run.output_document_id || run.draft_report_id)
    const shouldNotifyCompletion  = !!agent.notify_on_completion
    const shouldNotifyOutput      = !!agent.notify_on_output && hasOutput
    const perRunRequested         = !!(run.notify_email || run.notify_slack_channel)

    if (!shouldNotifyCompletion && !shouldNotifyOutput && !perRunRequested) return
    if (!emailTo && !slackChan) return

    const appUrl  = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.navhub.co'
    const runUrl  = `${appUrl}/agents/runs/${run.id}`
    const subject = `Agent run complete: ${run.run_name ?? agent.name}`
    const bodyHtml = `
      <p><strong>${agent.name}</strong> has finished a run.</p>
      ${run.run_name ? `<p>Run: ${run.run_name}</p>` : ''}
      <p>Status: ${run.status}</p>
      <p><a href="${runUrl}">View run →</a></p>
    `

    // Email via Resend
    if (emailTo && process.env.RESEND_API_KEY) {
      try {
        const { Resend } = await import('resend')
        const resend = new Resend(process.env.RESEND_API_KEY)
        const domain = process.env.RESEND_FROM_DOMAIN ?? 'navhub.co'
        await resend.emails.send({
          from:    `NavHub <notifications@${domain}>`,
          to:      emailTo.split(',').map(e => e.trim()).filter(Boolean),
          subject,
          html:    bodyHtml,
        })
      } catch (err) {
        console.error('sendRunNotifications: email failed', err)
      }
    }

    // Slack via bot token
    if (slackChan) {
      try {
        const admin = createAdminClient()
        const { data: conn } = await admin
          .from('slack_connections')
          .select('bot_token_encrypted')
          .eq('group_id', groupId)
          .eq('is_active', true)
          .maybeSingle()

        if (conn?.bot_token_encrypted) {
          const token = decrypt(conn.bot_token_encrypted)
          await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
              'Content-Type':  'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({
              channel: slackChan,
              text:    `*${agent.name}* run complete${run.run_name ? ` — ${run.run_name}` : ''}\n<${runUrl}|View run>`,
            }),
          })
        }
      } catch (err) {
        console.error('sendRunNotifications: slack failed', err)
      }
    }
  } catch (err) {
    console.error('sendRunNotifications: unexpected error', err)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Main execution function
// ────────────────────────────────────────────────────────────────────────────

export async function executeAgentRun(
  runId:     string,
  agent:     Agent,
  context:   RunContext,
  groupName: string,
  onChunk:   (event: RunEvent) => void
): Promise<void> {
  const admin = createAdminClient()

  // Update run status to running
  await admin
    .from('agent_runs')
    .update({
      status:      'running',
      started_at:  new Date().toISOString(),
      model_used:  ((agent as Agent & { ai_model?: string | null }).ai_model
                    ?? agent.model_name
                    ?? agent.model) as string,
    })
    .eq('id', runId)

  const groupId = agent.group_id

  // ── Activity-aware idle timeout ─────────────────────────────────────────
  // Was a fixed 5-minute wall-clock cap; that aborted long-but-active runs.
  // Now: 3 minutes of NO activity (no streamed chunk, no completed tool)
  // flips cancellation_requested. Active runs can take as long as they need;
  // genuinely stuck ones are still killed at the next iteration checkpoint.
  const IDLE_TIMEOUT_MS = 3 * 60 * 1000
  const fireIdleTimeout = () => {
    console.error(`[runner] Idle timeout — no activity for 3 minutes on run ${runId}`)
    void admin
      .from('agent_runs')
      .update({ cancellation_requested: true })
      .eq('id', runId)
      .eq('status', 'running')
  }
  let hardTimeoutHandle: ReturnType<typeof setTimeout> = setTimeout(fireIdleTimeout, IDLE_TIMEOUT_MS)
  function resetActivityTimer() {
    clearTimeout(hardTimeoutHandle)
    hardTimeoutHandle = setTimeout(fireIdleTimeout, IDLE_TIMEOUT_MS)
  }

  try {
    // Load credentials
    const credentials = await loadCredentials(agent.id)

    // ── Resolve provider + model + API key ───────────────────────────────────
    // Priority order:
    //   1. Agent's ai_provider + ai_model (migration 043) + matching
    //      group_provider_configs entry for the API key.
    //   2. Legacy: agent.model_config_id → group_model_configs (migration 042).
    //   3. Legacy: group default in group_model_configs.
    //   4. Superadmin provider defaults (for admin Sage + Assistant fallback).
    //   5. Final fallback: env var ANTHROPIC_API_KEY (handled inside callClaude).
    let cfgProvider = 'anthropic'
    let cfgModelName = agent.model as string
    let cfgApiKey: string | undefined

    const aiProvider = (agent as Agent & { ai_provider?: string | null }).ai_provider ?? null
    const aiModel    = (agent as Agent & { ai_model?: string | null }).ai_model       ?? null

    if (aiProvider) {
      const { data: provRow } = await admin
        .from('group_provider_configs')
        .select('api_key_encrypted, base_url')
        .eq('group_id', groupId)
        .eq('provider', aiProvider)
        .eq('is_active', true)
        .maybeSingle()
      cfgProvider  = aiProvider
      cfgModelName = aiModel ?? cfgModelName
      if (provRow) {
        try { cfgApiKey = decrypt(provRow.api_key_encrypted as string) } catch { /* keep undefined */ }
      }
    }

    if (!cfgApiKey) {
      // Legacy fallback: group_model_configs
      type CfgRow = { provider: string; model_name: string; api_key_encrypted: string }
      const tryConfigId = (agent as Agent & { model_config_id?: string | null }).model_config_id ?? null
      let cfgRow: CfgRow | null = null
      if (tryConfigId) {
        const { data } = await admin
          .from('group_model_configs')
          .select('provider, model_name, api_key_encrypted')
          .eq('id', tryConfigId)
          .eq('is_active', true)
          .maybeSingle()
        cfgRow = (data as unknown as CfgRow | null) ?? null
      }
      if (!cfgRow) {
        const { data } = await admin
          .from('group_model_configs')
          .select('provider, model_name, api_key_encrypted')
          .eq('group_id', groupId)
          .eq('is_default', true)
          .eq('is_active', true)
          .maybeSingle()
        cfgRow = (data as unknown as CfgRow | null) ?? null
      }
      if (cfgRow) {
        // Only adopt the legacy provider/model if no ai_provider was set on the agent
        if (!aiProvider) {
          cfgProvider  = cfgRow.provider
          cfgModelName = cfgRow.model_name
        }
        try { cfgApiKey = decrypt(cfgRow.api_key_encrypted) } catch { /* keep undefined */ }
      }
    }

    if (!cfgApiKey && aiProvider) {
      // Superadmin fallback: check superadmin_provider_configs for this provider
      // (used only when group has not configured the provider)
      const { data: superRow } = await admin
        .from('superadmin_provider_configs')
        .select('api_key_encrypted, base_url')
        .eq('provider', aiProvider)
        .eq('is_active', true)
        .maybeSingle()
      if (superRow) {
        try { cfgApiKey = decrypt(superRow.api_key_encrypted as string) } catch { /* keep undefined */ }
      }
    }

    // Persist the fully-resolved model name so /agents/runs/[id] shows the
    // actual model that ran (provider config takes priority over agent.model).
    void admin
      .from('agent_runs')
      .update({ model_used: cfgModelName })
      .eq('id', runId)

    // ── Materialise linked documents into agent_run_attachments ──────────────
    // Pulled in once per run from the run.linked_document_ids column.
    const { data: runRow } = await admin
      .from('agent_runs')
      .select('linked_document_ids, linked_report_ids, output_folder_id, output_status, output_name_override, output_type, task_complexity, preload_context')
      .eq('id', runId)
      .single()
    const linkedIds       = (runRow?.linked_document_ids ?? []) as string[]
    const linkedReportIds = (runRow?.linked_report_ids   ?? []) as string[]
    const taskComplexity = ((runRow as { task_complexity?: string } | null)?.task_complexity
                              ?? 'standard') as TaskComplexity
    const complexityCfg  = TASK_COMPLEXITY_SETTINGS[taskComplexity] ?? TASK_COMPLEXITY_SETTINGS.standard
    if (linkedIds.length > 0) {
      const { data: docs } = await admin
        .from('documents')
        .select('id, title, content_markdown, file_path, file_name, file_type')
        .in('id', linkedIds)
      for (const d of (docs ?? []) as Array<{ id: string; title: string; content_markdown: string | null; file_path: string | null; file_name: string | null; file_type: string | null }>) {
        await admin.from('agent_run_attachments').insert({
          run_id:       runId,
          file_name:    d.file_name ?? d.title,
          file_type:    d.file_type ?? 'text/markdown',
          file_path:    d.file_path ?? '',
          content_text: d.content_markdown ?? '',
        })
      }
    }

    // ── Materialise linked reports into agent_run_attachments ──────────────
    // Reports live in Storage as HTML — we strip tags + collapse whitespace
    // and clamp to 50k chars so the agent can read them with read_attachment
    // just like any other text file.
    if (linkedReportIds.length > 0) {
      const { data: reports } = await admin
        .from('custom_reports')
        .select('id, name, file_path')
        .in('id', linkedReportIds)
      for (const r of (reports ?? []) as Array<{ id: string; name: string; file_path: string | null }>) {
        let contentText = ''
        if (r.file_path) {
          try {
            const { data: fileData } = await admin.storage
              .from('report-files')
              .download(r.file_path)
            if (fileData) {
              const html = await fileData.text()
              contentText = html
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
                .replace(/<[^>]*>/g, ' ')
                .replace(/&nbsp;/gi, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 50_000)
            }
          } catch (err) {
            console.error('[runner] linked report download failed:', err)
          }
        }
        await admin.from('agent_run_attachments').insert({
          run_id:       runId,
          file_name:    r.name,
          file_type:    'text/html',
          file_path:    r.file_path ?? '',
          content_text: contentText,
        })
      }
    }

    // Fetch attachments for this run (includes linked docs just inserted above)
    const { data: runAttachments } = await admin
      .from('agent_run_attachments')
      .select('file_name, file_type')
      .eq('run_id', runId)
    const attachments = (runAttachments ?? []) as Array<{ file_name: string; file_type: string }>

    // Build system prompt (includes attachment context if any)
    let systemPrompt = await buildSystemPrompt(agent, groupName, context, groupId, attachments)

    // ─ Tool list derivation ────────────────────────────────────────────────
    // Tools are derived from the agent's feature × company access matrix
    // (agent_company_access). If no access rows exist at all, the agent
    // defaults to full access on every feature — preserves legacy-agent
    // behaviour created before migration 039.

    // Per-agent tool overrides (enabled flag per tool_name) — can disable a
    // feature-enabled tool OR enable an opt-in tool like web_search.
    const { data: overrideRows } = await admin
      .from('agent_tool_overrides')
      .select('tool_name, enabled')
      .eq('agent_id', agent.id)
    const disabledToolNames = new Set(
      (overrideRows ?? []).filter(r => !r.enabled).map(r => r.tool_name as string),
    )
    const enabledByOverride = new Set(
      (overrideRows ?? []).filter(r => r.enabled).map(r => r.tool_name as string),
    )

    // Load access matrix
    const { data: accessRows } = await admin
      .from('agent_company_access')
      .select('feature, access')
      .eq('agent_id', agent.id)

    const hasRead = (f: string) => !accessRows?.length ||
      accessRows.some(r => r.feature === f && ['read', 'write'].includes(r.access as string))
    const hasWrite = (f: string) => !accessRows?.length ||
      accessRows.some(r => r.feature === f && r.access === 'write')

    // Helper to push a tool def if it exists in ALL_TOOL_DEFS
    const push = (toolName: string) => {
      const def = ALL_TOOL_DEFS[toolName]
      if (def) toolDefs.push(def as Record<string, unknown>)
    }

    const toolDefs: Array<Record<string, unknown>> = []

    // Always available
    push('ask_user')
    push('read_attachment')

    // Feature-gated built-in tools
    if (hasRead('financials')) {
      push('read_financials')
      push('read_cashflow')
      push('read_cashflow_items')
      push('summarise_cashflow')
    }
    if (hasWrite('financials')) {
      push('suggest_cashflow_item')
      push('update_cashflow_item')
      push('create_cashflow_snapshot')
    }
    if (hasRead('documents')) {
      push('read_document')
      push('list_documents')
      push('analyse_document')
    }
    if (hasWrite('documents')) {
      push('create_document')
      push('update_document')
    }
    if (hasRead('reports')) {
      push('list_report_templates')
      push('read_report_template')
    }
    if (hasWrite('reports')) {
      push('render_report')
      push('generate_report')
      push('create_report_template')
      push('update_report_template')
    }
    if (hasRead('marketing')) {
      push('read_marketing_data')
      push('summarise_marketing')
    }

    // Communication tools — available whenever notifications are configured
    // (these are not gated by feature access; they use the agent's notify settings)
    push('send_email')
    push('send_slack')

    // Group-level toggles: web search (when enabled group-wide OR per-agent override)
    try {
      const { data: grp } = await admin
        .from('groups')
        .select('web_search_enabled')
        .eq('id', groupId)
        .single()
      const groupWebSearch = !!grp?.web_search_enabled
      const agentWebSearch = enabledByOverride.has('web_search')
      const shouldEnableWebSearch = (groupWebSearch || agentWebSearch) && !disabledToolNames.has('web_search')
      if (shouldEnableWebSearch) {
        toolDefs.push({
          name:        'web_search',
          description: 'Search the public web for current information. Use only when you need up-to-date information not available via internal tools. Returns a list of relevant URLs and snippets.',
          input_schema: {
            type:       'object',
            properties: {
              query: { type: 'string', description: 'The search query.' },
            },
            required: ['query'],
          },
        })
      }
    } catch { /* ignore */ }

    // Inject custom webhook tools for this group
    try {
      const { data: customTools } = await admin
        .from('custom_tools')
        .select('name, description, parameters')
        .eq('group_id', groupId)
        .eq('is_active', true)

      for (const ct of customTools ?? []) {
        if (disabledToolNames.has(ct.name as string)) continue
        const params = (ct.parameters ?? []) as Array<{ name: string; type: string; required: boolean; description: string }>
        toolDefs.push({
          name:        ct.name,
          description: ct.description,
          input_schema: {
            type:       'object',
            properties: Object.fromEntries(params.map(p => [p.name, { type: p.type, description: p.description }])),
            required:   params.filter(p => p.required).map(p => p.name),
          },
        })
      }
    } catch { /* ignore */ }

    // Apply disabled overrides — strip any tool explicitly disabled for this agent.
    // (ask_user is never disabled — it is a runner-level mechanism.)
    if (disabledToolNames.size > 0) {
      const filtered = toolDefs.filter(t => {
        const name = (t as { name?: string }).name
        if (name === 'ask_user') return true
        return !disabledToolNames.has(name ?? '')
      })
      toolDefs.length = 0
      for (const t of filtered) toolDefs.push(t)
    }

    // ── Agent template (migration 060) ──────────────────────────────────────
    // When an agent was cloned from a platform template, the template's
    // persona / instructions / platform knowledge / template-bound skills
    // are injected here. All of it is hidden from end users — they only see
    // the agent's own name/description on the run page, but the template's
    // expertise drives the actual behaviour.
    const templateId = (agent as Agent & { template_id?: string | null }).template_id ?? null
    if (templateId) {
      const { data: tpl } = await admin
        .from('agent_templates')
        .select(`
          id, name, persona, instructions, communication_style, response_length,
          agent_template_skills (
            sort_order,
            skills ( name, instructions, knowledge_text, examples, tool_grants )
          ),
          agent_template_knowledge (
            sort_order,
            platform_knowledge ( title, content )
          )
        `)
        .eq('id', templateId)
        .maybeSingle()

      if (tpl) {
        // Supabase types embedded relations widely — cast via unknown so the
        // narrower shape we actually consume below typechecks regardless of
        // whether the relation came back as an object or a single-row array.
        const t = tpl as unknown as {
          name:          string
          persona:       string | null
          instructions:  string | null
          agent_template_skills?:    Array<{ sort_order: number; skills: { name: string; instructions: string; knowledge_text: string | null; examples: string | null; tool_grants: string[] | null } | null }>
          agent_template_knowledge?: Array<{ sort_order: number; platform_knowledge: { title: string; content: string } | null }>
        }

        if (t.persona?.trim()) {
          systemPrompt = `${t.persona.trim()}\n\n${systemPrompt}`
        }
        if (t.instructions?.trim()) {
          systemPrompt += `\n\n## Core Expertise (template: ${t.name})\n${t.instructions.trim()}`
        }

        // Template-bound platform knowledge — inline content directly.
        const knowledgeRows = (t.agent_template_knowledge ?? [])
          .filter(k => !!k.platform_knowledge)
          .sort((a, b) => a.sort_order - b.sort_order)
        if (knowledgeRows.length > 0) {
          systemPrompt += '\n\n## Platform Knowledge'
          for (const k of knowledgeRows) {
            const pk = k.platform_knowledge!
            systemPrompt += `\n\n### ${pk.title}\n${pk.content}`
          }
        }

        // Template-bound skills — same shape as loadSkillsForRun output.
        // Tool grants are folded into the toolDefs pool below.
        const templateSkillRows = (t.agent_template_skills ?? [])
          .filter(s => !!s.skills)
          .sort((a, b) => a.sort_order - b.sort_order)
        if (templateSkillRows.length > 0) {
          const blocks: string[] = ['## Template Skills (applied automatically)']
          for (const s of templateSkillRows) {
            const sk = s.skills!
            const parts: string[] = [`### ${sk.name}`, sk.instructions]
            if (sk.knowledge_text?.trim())  parts.push(`\n**Knowledge:**\n${sk.knowledge_text.trim()}`)
            if (sk.examples?.trim())        parts.push(`\n**Examples:**\n${sk.examples.trim()}`)
            blocks.push(parts.join('\n'))
          }
          systemPrompt += '\n\n' + blocks.join('\n\n')
          // Pull in any tool grants the template's skills carry.
          for (const s of templateSkillRows) {
            for (const tg of s.skills!.tool_grants ?? []) {
              if (toolNameAlreadyPresent(toolDefs, tg)) continue
              if (disabledToolNames.has(tg))            continue
              const def = ALL_TOOL_DEFS[tg]
              if (def) toolDefs.push(def as Record<string, unknown>)
            }
          }
        }
      }
    }

    // ── Skills (migration 056) ──────────────────────────────────────────────
    // Auto-injects platform → group → agent skills. Each skill contributes:
    //   • a system-prompt block (instructions + knowledge_text + reference
    //     documents content + examples)
    //   • optional tool_grants — tools that get unlocked even if not
    //     enabled on the agent directly
    // Skills are transparent to users; they never need to instruct an
    // agent to use them.
    const skillsBundle = await loadSkillsForRun(agent.id, groupId, admin)
    if (skillsBundle.promptBlock) {
      systemPrompt += '\n\n' + skillsBundle.promptBlock
    }
    for (const grantedName of skillsBundle.toolGrants) {
      if (toolNameAlreadyPresent(toolDefs, grantedName)) continue
      if (disabledToolNames.has(grantedName)) continue
      const def = ALL_TOOL_DEFS[grantedName]
      if (def) toolDefs.push(def as Record<string, unknown>)
    }

    // ─ System-prompt addenda — kept compact ─────────────────────────────────
    // Earlier revisions added six prose blocks totalling ~3k tokens of overhead
    // on every run. The full tool definitions are already passed via the API
    // `tools` arg, so the model knows each tool's signature without us
    // re-listing them here. We only add CONDITIONAL blocks that aren't
    // already implicit in the tool schemas.
    const toolNameSet = new Set(
      toolDefs
        .map(t => (t as { name?: string }).name)
        .filter((n): n is string => !!n),
    )
    const hasDocTools     = toolNameSet.has('create_document') || toolNameSet.has('update_document')
    const hasReportTools  = toolNameSet.has('render_report')   || toolNameSet.has('list_report_templates')
    const hasAttachTool   = toolNameSet.has('read_attachment')
    const hasReadDocTool  = toolNameSet.has('read_document')
    const hasAttachments  = !!attachments && attachments.length > 0

    // Task-complexity tier — single line each (was 4 lines × 4 tiers).
    const tierMessage: Record<TaskComplexity, string> = {
      standard:     `Stay frugal — small task, no heroics needed.`,
      medium:       `Sizeable task — roll your sleeves up but avoid unnecessary tool calls.`,
      large:        `Heavy lift — work methodically; summarise progress every 5 tool calls.`,
      massive:      `Open the throttle — work in phases, summarise progress every 5 tool calls, use full token budget for long outputs.`,
      professional: `Professional capability. No meaningful iteration limit. All linked documents and attachments have been pre-loaded into this context — reference them directly without read_document / read_attachment unless you need a document not already shown. Complete the task to professional standard. Do not truncate, summarise prematurely, or stop before the work is done. This is the equivalent of what a professional firm would charge thousands of dollars for — deliver accordingly.`,
    }
    if (taskComplexity === 'professional') {
      systemPrompt += `

## Effort level: professional — full capability
${tierMessage.professional}

Begin immediately. No estimated-time line is required for professional runs.`
    } else {
      systemPrompt += `

## Effort level (${taskComplexity})
${tierMessage[taskComplexity]} Up to ${complexityCfg.maxIterations} iterations · ${complexityCfg.maxTokens.toLocaleString()}-token budget per response.

Before any work, output one line in the format: ⏱ Estimated time: [X min] — [what you'll do]. Then begin immediately without confirmation.`
    }

    // Pre-flight check — every run, regardless of tier. Forces the agent to
    // verify access to every resource it needs BEFORE starting, batching
    // any missing-resource issues into one ask_user call.
    systemPrompt += `

## Pre-flight check (REQUIRED before starting any task)
Before doing ANY work, you MUST:
1. List every resource you will need: documents, reports, attachments, financial data, companies.
2. Verify you can access each one by calling the appropriate tool (list_documents, list_report_templates, read_attachment, read_companies, list of attached file_names from the system prompt, etc.).
3. If ANYTHING is missing or inaccessible, call ask_user IMMEDIATELY with ONE clear message listing ALL missing items.
4. Only begin the actual task after confirming all resources are accessible.

Example if resources are missing:
"Before I start, I need to confirm access to: (1) the Q1 Financial Report attachment, (2) financial data for AxisTech Rural. I can see the attachment but cannot find the financial data. Can you confirm the company name or attach the relevant data?"

Never start work and then discover mid-task that you cannot access something. Never ask about missing resources one at a time — list all issues in a single ask_user call. If all resources are accessible, proceed silently without commenting on the pre-flight check.`

    // Document creation guidance — only when create/update tools are enabled.
    if (hasDocTools) {
      systemPrompt += `

## Documents
- create_document accepts the full markdown body in content_markdown — no soft cap, do not truncate.
- create_document returns {"success":true,"document_id":"<uuid>",...}. Use the top-level document_id verbatim with update_document. Never pass "undefined", an empty string, or a guess.
- For documents created in this run, read them back with read_document(document_id) — not read_attachment.
- Titles support all punctuation; only < > : " / \\ | ? * cause downstream filename issues. On a title-related failure, retry with only those nine replaced by a hyphen, then surface via ask_user if it fails again.`
    }

    // Report-generation flow — only when those tools are enabled.
    if (hasReportTools) {
      systemPrompt += `

## Reports
- list_report_templates → read_report_template(template_id) → render_report(template_id, slot_data). Never skip steps or guess a template_id.`
    }

    // Attachment guidance — only when read_attachment is enabled AND there
    // are actually attached files.
    if (hasAttachTool && hasAttachments) {
      systemPrompt += `

## Attachments
- Call read_attachment with the EXACT file_name shown in quotes in the "Attached files for this run" list. Do not append the MIME type. Do not paraphrase.`
    }

    // Reading large documents — only when read_document is available. The
    // tool returns 20k-char chunks; the agent must page through them before
    // counting entries or reporting completeness.
    if (hasReadDocTool) {
      systemPrompt += `

## Reading large documents
- read_document returns content in 20,000-character chunks. ALWAYS check has_more in the response.
- If has_more is true, call read_document again with chunk: 2, then 3, etc. until has_more is false.
- For verification tasks (counting entries, checking completeness, listing all items), read EVERY chunk before reporting. Never report a count or assessment from a partial read.`
    }

    // Failure-handling — universal but compact.
    systemPrompt += `

## When tools fail
Retry once with corrected params. If a second attempt also fails, call ask_user rather than silently giving up. Never retry any single tool more than twice consecutively.

## Completing tasks fully
- Before starting, estimate how many tool calls this task will require. If it will exceed your iteration limit (${complexityCfg.maxIterations}), call ask_user immediately: "This looks like roughly N tool calls but I have ${complexityCfg.maxIterations} available. Should I proceed with what fits, or restart at a larger size (Open the throttle / massive)?"
- When you cross 80% of your iteration budget without finishing, output a one-line progress note: "📊 Progress: X done, Y remaining — on track / may need a follow-up run."
- Never present partial output as if it is complete. If you run out of iterations or token budget mid-task, your FINAL message MUST start with: "⚠️ PARTIAL OUTPUT — completed X of Y items. To continue, start a follow-up run with brief: <specific continuation instructions>".
- For long outputs, split across multiple update_document calls rather than truncating silently.`

    // ── Pre-loaded document context (professional tier) ─────────────────────
    // When the run's tier (or explicit preload_context flag) opts in, inline
    // every linked document + attachment's text content into the system
    // prompt. The agent can then reference them by name without burning
    // iterations on read_document / read_attachment for already-known files.
    const preloadFlag = !!(runRow as { preload_context?: boolean } | null)?.preload_context
    if (complexityCfg.preloadContext || preloadFlag) {
      const preloadParts: string[] = []

      // Linked documents — full content_markdown
      if (linkedIds.length > 0) {
        const { data: linkedDocs } = await admin
          .from('documents')
          .select('id, title, content_markdown')
          .in('id', linkedIds)
        for (const d of (linkedDocs ?? []) as Array<{ id: string; title: string; content_markdown: string | null }>) {
          if (d.content_markdown && d.content_markdown.trim().length > 0) {
            preloadParts.push(`### Document: ${d.title}\n\n${d.content_markdown}`)
          }
        }
      }

      // Run attachments — content_text already extracted at upload time
      const { data: preloadAttachments } = await admin
        .from('agent_run_attachments')
        .select('file_name, content_text')
        .eq('run_id', runId)
      for (const att of (preloadAttachments ?? []) as Array<{ file_name: string; content_text: string | null }>) {
        if (att.content_text && att.content_text.trim().length > 0) {
          preloadParts.push(`### Attachment: ${att.file_name}\n\n${att.content_text}`)
        }
      }

      if (preloadParts.length > 0) {
        systemPrompt += `\n\n## Pre-loaded Documents and Attachments\nThe following materials are inlined directly in this context. Reference them by name; do not call read_document or read_attachment for any of these.\n\n${preloadParts.join('\n\n---\n\n')}`
        const totalContextChars = systemPrompt.length
        console.log(`[runner] Pre-loaded ${preloadParts.length} item(s). System prompt now ${totalContextChars} chars (~${Math.round(totalContextChars / 4)} tokens)`)
      }
    }

    // Initial messages
    const messages: AnthropicMessage[] = [
      {
        role:    'user',
        content: [
          context.extra_instructions
            ? `Please complete your assigned task. Additional context: ${context.extra_instructions}`
            : 'Please complete your assigned task.',
          context.period ? `Focus on period: ${context.period}` : '',
          context.company_ids?.length
            ? `Focus on companies: ${context.company_ids.join(', ')}`
            : '',
        ].filter(Boolean).join('\n'),
      },
    ]

    let fullOutput     = ''
    let totalTokens    = 0
    let continueLoop   = true
    const toolCallLogs: ToolCallLog[] = []

    // Incremental output persistence — every N chunks we flush fullOutput
    // (and current tool_calls / tokens) to the DB so the run-detail page can
    // observe progress even if no SSE consumer is connected. The poll-based
    // stream route reads from these columns to reconstruct streaming.
    let chunksSinceLastSave = 0
    const SAVE_EVERY_CHUNKS = 10
    const persistProgress = () => {
      void admin.from('agent_runs').update({
        output:       fullOutput,
        tool_calls:   toolCallLogs,
        tokens_used:  totalTokens,
      }).eq('id', runId)
    }
    const onTextChunk = (chunk: string) => {
      fullOutput += chunk
      chunksSinceLastSave++
      if (chunksSinceLastSave >= SAVE_EVERY_CHUNKS) {
        chunksSinceLastSave = 0
        persistProgress()
      }
    }

    // Loop guards — prevent infinite tool call loops. Iteration cap, max
    // tokens per response and per-tool failure tolerance all scale with the
    // selected task_complexity tier (see TASK_COMPLEXITY_SETTINGS).
    const MAX_ITERATIONS    = complexityCfg.maxIterations
    const MAX_TOOL_FAILURES = complexityCfg.maxToolFailures
    const MAX_TOKENS_PER_CALL = complexityCfg.maxTokens
    let   iterationCount    = 0
    const toolFailureCounts: Record<string, number> = {}
    // Wall-clock cap removed — replaced by the activity-aware idle timer
    // declared above (`resetActivityTimer`). Active long runs can now finish.

    // Agentic loop — continue until no more tool calls
    while (continueLoop) {
      iterationCount++

      if (iterationCount > MAX_ITERATIONS) {
        const msg = `\n\n⚠️ **Partial output** — reached the ${MAX_ITERATIONS}-iteration limit before completing all work.\n\nTo continue: start a follow-up run with "Continue from where you left off" as your brief.\n\nIf this task consistently requires more iterations, choose a larger task size (Open the throttle / massive) on the run launcher.\n`
        fullOutput += msg
        onChunk({ type: 'text', content: msg })
        continueLoop = false
        break
      }
      // ── Cancellation checkpoint ──────────────────────────────────────────
      // Poll the DB at the start of every iteration. If a cancel was requested
      // (via POST /api/agents/runs/[id]/cancel) while we were executing tools,
      // we stop here before the next model call.
      const { data: cancelCheck } = await admin
        .from('agent_runs')
        .select('cancellation_requested')
        .eq('id', runId)
        .single()
      if (cancelCheck?.cancellation_requested) {
        // Persist whatever the agent has produced so far (text + tool calls)
        // so the run detail page can show partial progress instead of a blank.
        await admin
          .from('agent_runs')
          .update({
            status:       'cancelled',
            cancelled_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            output:       fullOutput || null,
            tool_calls:   toolCallLogs,
            tokens_used:  totalTokens,
          })
          .eq('id', runId)
        onChunk({ type: 'cancelled' })
        return
      }
      // ────────────────────────────────────────────────────────────────────

      // Initialised inside the provider branch below (or via the rate-limit
      // retry loop). The non-null assertion below the branch is safe because
      // the only way to leave the branch without `result` is via the cancel
      // break or a thrown error.
      let result: ModelResponse = { text: '', tool_calls: [], tokens: 0 }

      // Provider routing: prefer model config provider; fall back to legacy
      // gpt-4o sniff against agent.model.
      const useOpenAI = cfgProvider === 'openai' || agent.model === 'gpt-4o'

      // For Anthropic calls, pass cfgApiKey through credentials so callClaude
      // picks it up via its existing BYO-key branch.
      const claudeCreds: Record<string, string> = { ...credentials }
      if (cfgApiKey && cfgProvider === 'anthropic') claudeCreds['anthropic_api_key'] = cfgApiKey
      const openAICreds: Record<string, string> = { ...credentials }
      if (cfgApiKey && cfgProvider === 'openai')    openAICreds['OPENAI_API_KEY']    = cfgApiKey

      // Belt-and-braces: race the model call against an explicit budget.
      // callClaude/callGPT4o already have AbortController + idle timers,
      // but if the underlying socket is held open without progress those
      // abort paths can stall too.
      //
      // Vercel Pro caps function duration at 300 s. Per-call budgets must
      // fit inside that cap with margin for tool execution + DB writes —
      // otherwise the lambda gets killed and the run stalls in `running`
      // until /api/cron/cleanup-stuck-runs marks it failed. Tiers scale
      // the per-call budget; professional/massive runs that need more wall
      // clock complete across multiple cron invocations of
      // /api/cron/process-queued-runs (tracked separately).
      const MODEL_TIMEOUT_MS =
        taskComplexity === 'professional' ? 240_000 :  //  4 min — leaves ~60 s for tool + commit
        taskComplexity === 'massive'      ? 180_000 :  //  3 min
        taskComplexity === 'large'        ? 120_000 :  //  2 min
                                             90_000    //  1.5 min default (standard / medium)
      const withTimeout = <T>(p: Promise<T>, label: string): Promise<T> =>
        Promise.race([
          p,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`TIMEOUT:${label}`)), MODEL_TIMEOUT_MS),
          ),
        ])

      if (useOpenAI) {
        result = await withTimeout(
          callGPT4o(messages, toolDefs, systemPrompt, openAICreds, (chunk) => {
            onChunk({ type: 'text', content: chunk })
            onTextChunk(chunk)
            resetActivityTimer()
          }),
          'callGPT4o',
        )
      } else {
        // Use the resolved model name from config when present; fall back to agent.model
        const modelToUse = cfgProvider === 'anthropic' && cfgModelName ? cfgModelName : agent.model
        // Mid-stream cancellation poller — passed into callClaude so it can
        // bail in the middle of a long model response, not just at iteration
        // boundaries.
        const isCancelledFn = async () => {
          const { data } = await admin
            .from('agent_runs')
            .select('cancellation_requested')
            .eq('id', runId)
            .single()
          return !!(data as { cancellation_requested?: boolean } | null)?.cancellation_requested
        }

        // Retry loop for transient rate limits. callClaude throws
        // RATE_LIMITED:N on a 429; we sleep N seconds and retry up to
        // MAX_RATE_LIMIT_RETRIES before giving up.
        const MAX_RATE_LIMIT_RETRIES = 3
        let rateLimitRetries = 0
        let cancelledBreak = false

        while (true) {
          try {
            result = await withTimeout(
              callClaude(modelToUse as AgentModel, messages, toolDefs, systemPrompt, (chunk) => {
                onChunk({ type: 'text', content: chunk })
                onTextChunk(chunk)
                resetActivityTimer()
              }, claudeCreds, MAX_TOKENS_PER_CALL, isCancelledFn),
              'callClaude',
            )
            break
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)

            // Mid-stream cancellation — preserve partial output and bail
            if (msg === 'CANCELLED_MID_STREAM') {
              await admin.from('agent_runs').update({
                status:       'cancelled',
                cancelled_at: new Date().toISOString(),
                completed_at: new Date().toISOString(),
                output:       fullOutput || null,
                tool_calls:   toolCallLogs,
                tokens_used:  totalTokens,
              }).eq('id', runId)
              onChunk({ type: 'cancelled' })
              continueLoop  = false
              cancelledBreak = true
              break
            }

            // 429 — sleep and retry
            if (msg.startsWith('RATE_LIMITED:') && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
              rateLimitRetries++
              const waitSeconds = Math.max(1, parseInt(msg.split(':')[1] ?? '10', 10))
              const note = `\n\n⏳ Rate limit reached — waiting ${waitSeconds}s before continuing (attempt ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES})…\n\n`
              onChunk({ type: 'text', content: note })
              onTextChunk(note)
              resetActivityTimer()
              await new Promise(r => setTimeout(r, waitSeconds * 1000))
              continue
            }

            throw err
          }
        }

        if (cancelledBreak) break
      }

      totalTokens += result.tokens

      if (result.text) {
        fullOutput += result.text
      }
      // Flush per-iteration progress so observers (the poll-based stream
      // route, the run-detail page, the runs list) see fresh output and
      // accurate token totals even between long tool calls.
      persistProgress()

      if (result.tool_calls.length === 0) {
        // No more tool calls — done
        continueLoop = false
        break
      }

      // Add assistant message with tool uses
      const assistantContent: AnthropicContent[] = []
      if (result.text) {
        assistantContent.push({ type: 'text', text: result.text })
      }
      for (const tc of result.tool_calls) {
        assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
      }
      messages.push({ role: 'assistant', content: assistantContent })

      // Execute tools
      const toolResults: AnthropicContent[] = []

      for (const tc of result.tool_calls) {
        const toolName = tc.name as AgentTool
        const startTs  = Date.now()

        // Diagnostic log — helps debug tool input issues
        console.log('Tool call raw:', JSON.stringify({
          tool:        tc.name,
          input:       tc.input,
          inputKeys:   Object.keys(tc.input || {}),
          inputValues: Object.values(tc.input || {}),
        }))

        onChunk({ type: 'tool_start', tool: toolName, input: tc.input })

        // Persist a "started" placeholder + the current_tool pointer so
        // the stream-route poller can emit tool_start to clients that
        // connect mid-run BEFORE the tool finishes. The placeholder is
        // overwritten with the real output below; current_tool is cleared
        // once the tool returns.
        toolCallLogs.push({
          tool:        toolName,
          input:       tc.input,
          output:      '',
          timestamp:   new Date().toISOString(),
          duration_ms: 0,
        })
        const placeholderIdx = toolCallLogs.length - 1
        // Awaited so the poller (500 ms cadence) sees the new current_tool
        // before the next tick — gives clients an immediate "Reading X…"
        // indicator instead of waiting for the tool to complete.
        await admin
          .from('agent_runs')
          .update({ tool_calls: toolCallLogs, current_tool: toolName })
          .eq('id', runId)

        let output: string

        // ask_user is handled specially — it pauses the run and waits for user input
        if (toolName === 'ask_user') {
          const question = (tc.input.question as string) ?? 'Please provide additional information.'
          const answer   = await handleAskUser(question, runId, onChunk)

          if (answer === '__CANCELLED__') {
            // Cancellation detected during ask_user wait — preserve partial output
            await admin
              .from('agent_runs')
              .update({
                status:       'cancelled',
                cancelled_at: new Date().toISOString(),
                completed_at: new Date().toISOString(),
                output:       fullOutput,
                tool_calls:   toolCallLogs,
                tokens_used:  totalTokens,
              })
              .eq('id', runId)
            onChunk({ type: 'cancelled' })
            return
          }

          output = `User replied: ${answer}`
        } else {
          try {
            output = await executeTool(toolName, tc.input, agent, groupId, groupName, runId, credentials)
          } catch (err) {
            output = `Error: ${err instanceof Error ? err.message : 'Unknown error'}`
          }
        }

        const durationMs = Date.now() - startTs
        onChunk({ type: 'tool_end', tool: toolName, output })
        resetActivityTimer()

        // Track consecutive tool failures — stop if a tool fails too many times
        if (output.includes('"success":false') || output.startsWith('Error:')) {
          toolFailureCounts[toolName] = (toolFailureCounts[toolName] ?? 0) + 1
          if (toolFailureCounts[toolName] >= MAX_TOOL_FAILURES) {
            const errorMsg = `\n\n⚠️ Agent stopped: ${toolName} failed ${MAX_TOOL_FAILURES} times consecutively. Last error: ${output}`
            fullOutput += errorMsg
            onChunk({ type: 'text', content: errorMsg })
            continueLoop = false
          }
        } else {
          // Reset failure count on success
          toolFailureCounts[toolName] = 0
        }

        // Update the placeholder added before executeTool — keeps the array
        // length stable so a client that polled mid-execution sees the SAME
        // tool transition from "running" to "done" rather than a duplicate row.
        toolCallLogs[placeholderIdx] = {
          tool:        toolName,
          input:       tc.input,
          output:      output.slice(0, 2000), // truncate for storage
          timestamp:   new Date().toISOString(),
          duration_ms: durationMs,
        }

        // Incremental persist + clear the current_tool pointer. Awaited
        // so the next-iteration call to admin sees the cleared value and
        // the stream poller emits tool_end before the next tool_start.
        await admin
          .from('agent_runs')
          .update({ tool_calls: toolCallLogs, tokens_used: totalTokens, current_tool: null })
          .eq('id', runId)

        toolResults.push({
          type:        'tool_result',
          tool_use_id: tc.id,
          content:     output,
        })

        // If loop guard triggered, break inner loop too
        if (!continueLoop) break
      }

      // Add tool results to messages (only if loop is still running)
      if (continueLoop) messages.push({ role: 'user', content: toolResults })
    }

    // Check for generated draft report
    let draftReportId: string | null = null
    const generateToolLog = toolCallLogs.find(t => t.tool === 'generate_report')
    if (generateToolLog) {
      try {
        const parsed = JSON.parse(generateToolLog.output) as { report_id?: string }
        if (parsed.report_id) draftReportId = parsed.report_id
      } catch { /* not JSON */ }
    }

    // Save completed run
    await admin
      .from('agent_runs')
      .update({
        status:          'success',
        output:          fullOutput,
        tool_calls:      toolCallLogs,
        tokens_used:     totalTokens,
        draft_report_id: draftReportId,
        completed_at:    new Date().toISOString(),
      })
      .eq('id', runId)

    // Send notifications (fire-and-forget, won't block run)
    const { data: finalRun } = await admin
      .from('agent_runs')
      .select('id, status, run_name, output_document_id, draft_report_id, notify_email, notify_slack_channel')
      .eq('id', runId)
      .single()
    if (finalRun) {
      // Awaited — Vercel kills fire-and-forget after the response is sent.
      await sendRunNotifications(finalRun as RunForNotify, agent as unknown as AgentForNotify, agent.group_id)
    }

    onChunk({ type: 'done', tokens: totalTokens })

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error during agent run'

    await admin
      .from('agent_runs')
      .update({
        status:        'error',
        error_message: message,
        completed_at:  new Date().toISOString(),
      })
      .eq('id', runId)

    // Send error notification too
    const { data: errRun } = await admin
      .from('agent_runs')
      .select('id, status, run_name, output_document_id, draft_report_id, notify_email, notify_slack_channel')
      .eq('id', runId)
      .single()
    if (errRun) {
      await sendRunNotifications(errRun as RunForNotify, agent as unknown as AgentForNotify, agent.group_id)
    }

    onChunk({ type: 'error', message })
  } finally {
    // Always clear the hard-timeout safety net — including on early `return`s
    // from cancellation/iteration-cap/timeout branches inside the try block.
    clearTimeout(hardTimeoutHandle)
  }
}
