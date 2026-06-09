// ============================================================
// Enums / unions
// ============================================================

export type UserRole = 'super_admin' | 'group_owner' | 'group_admin' | 'manager' | 'viewer'

// ── Role & Permission types (migration 031, group_owner added in 062) ──
export type AppRole     = 'super_admin' | 'group_owner' | 'group_admin' | 'manager' | 'viewer'
export type FeatureKey  = 'financials' | 'reports' | 'documents' | 'marketing' | 'agents' | 'settings'
export type AccessLevel = 'none' | 'view' | 'edit'

export const FEATURE_KEYS: FeatureKey[] = ['financials', 'reports', 'documents', 'marketing', 'agents', 'settings']

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  financials: 'Financials',
  reports:    'Reports & Templates',
  documents:  'Documents',
  marketing:  'Marketing',
  agents:     'Agents',
  settings:   'Settings',
}

export const FEATURE_DESCRIPTIONS: Record<FeatureKey, string> = {
  financials: 'Dashboard, P&L, Balance Sheet, Cash Flow, Forecasting',
  reports:    'Custom Reports and Report Templates',
  documents:  'Document management, uploads and sharing',
  marketing:  'Marketing intelligence and analytics',
  agents:     'AI agents, runs and scheduling',
  settings:   'Group settings, integrations, members',
}

export const ROLE_LABELS: Record<AppRole, string> = {
  super_admin: 'Super Admin',
  group_owner: 'Owner',
  group_admin: 'Group Admin',
  manager:     'Manager',
  viewer:      'Viewer',
}

// Permission lookup: feature → company_id → access level
// key 'default' = null company_id (group-level default)
// key = company uuid = company-specific override
export type PermissionMatrix = Record<FeatureKey, Record<string, AccessLevel>>
export type ReportType = 'profit_loss' | 'balance_sheet' | 'cashflow'
export type DataSource = 'xero' | 'excel'
export type UploadStatus = 'processing' | 'complete' | 'error' | 'processed'
export type SyncStatus = 'success' | 'error'
export type EntityType = 'company' | 'division'

// ============================================================
// Database row types
// ============================================================

export interface Group {
  id:            string
  name:          string
  slug:          string
  primary_color: string
  palette_id:    string | null   // added Phase 2c — references PALETTES[].id
  // Per-group white-label branding (migration 047)
  brand_name?:   string | null
  brand_color?:  string | null
  logo_url?:     string | null
  // Maximum task complexity tier the group's users can pick on the run
  // launcher. Defaults to 'massive' (migration 054).
  max_task_complexity?: TaskComplexity
  // Group ownership (migration 062). The owner can manage group_admin
  // assignments; only super_admins can mint group_owners.
  owner_user_id?: string | null
  created_at:    string
}

export interface UserGroup {
  user_id: string
  group_id: string
  role: UserRole
  is_default: boolean
  group?: Group
}

export interface Company {
  id: string
  group_id: string
  name: string
  slug: string
  description: string | null
  industry: string | null
  is_active: boolean
  created_at: string
}

export interface Division {
  id: string
  company_id: string
  name: string
  slug: string
  description: string | null
  industry: string | null
  is_active: boolean
  created_at: string
}

export interface XeroConnection {
  id: string
  company_id: string | null
  division_id: string | null
  xero_tenant_id: string
  access_token: string
  refresh_token: string
  token_expiry: string
  connected_at: string
}

export interface FinancialSnapshot {
  id: string
  company_id: string | null
  division_id: string | null
  period: string
  report_type: ReportType
  source: DataSource
  data: FinancialData
  synced_at: string
}

export interface ExcelUpload {
  id:             string
  company_id:     string | null
  division_id:    string | null
  filename:       string
  storage_path:   string
  uploaded_by:    string
  uploaded_at:    string
  status:         UploadStatus
  error_message:  string | null
  // Phase 3b additions
  report_type?:   'pl' | 'bs' | 'tb' | null
  period_value?:  string | null
  column_mapping?: Record<string, string> | null
}

export interface SyncLog {
  id: string
  company_id: string | null
  division_id: string | null
  source: DataSource
  status: SyncStatus
  message: string | null
  created_at: string
}

// ============================================================
// Financial data JSONB structure (stored in financial_snapshots.data)
// ============================================================

export interface FinancialData {
  period: string             // YYYY-MM
  report_type: ReportType
  currency: string           // ISO 4217, e.g. "AUD"
  rows: FinancialRow[]
  generated_at: string       // ISO 8601
}

export interface FinancialRow {
  account_id?: string
  account_code?: string
  account_name: string
  row_type: 'header' | 'row' | 'summaryRow' | 'section'
  amount_cents: number | null  // whole cents, null if not applicable
  children?: FinancialRow[]
}

// ============================================================
// User settings
// ============================================================

export type NumberFormat = 'thousands' | 'full' | 'smart'
export type SupportedCurrency = 'AUD' | 'NZD' | 'USD' | 'GBP' | 'SGD'

export interface UserSettings {
  user_id:       string
  currency:      SupportedCurrency
  number_format: NumberFormat
  fy_end_month:  number    // 1–12; 6 = June (AU standard), Phase 3b
  created_at:    string
  updated_at:    string
}

// ─── Dashboard summary types ────────────────────────────────────────────────

export interface AppSummary {
  company_count:       number
  division_count:      number
  active_agent_count:  number
  alert_count:         number
  companies_with_xero: number
  last_synced_at:      string | null
}

export interface CurrentPosition {
  cash:                          number | null
  receivables:                   number | null
  total_current_assets:          number | null
  total_non_current_assets:      number | null
  payables:                      number | null
  total_current_liabilities:     number | null
  total_non_current_liabilities: number | null
  net_position:                  number | null
  as_at_period:                  string
  companies_included:            number
  companies_missing_data:        number
}

export interface PLBlock {
  revenue:             number | null
  cogs:                number | null
  gross_profit:        number | null
  operating_expenses:  number | null
  ebitda:              number | null
  periods_included:    string[]
}

export interface Performance {
  qtd:      PLBlock
  last_qtr: PLBlock
  ytd:      PLBlock
}

export interface DashboardSummary {
  app_summary:       AppSummary
  current_position:  CurrentPosition
  performance:       Performance
}

// ============================================================
// Group management types  (Phase 2f)
// ============================================================

export interface GroupInvite {
  id:          string
  group_id:    string
  email:       string
  role:        string
  invited_by:  string
  accepted_at: string | null
  created_at:  string
}

export interface GroupMember {
  user_id:   string
  email:     string
  role:      string
  is_default: boolean
  joined_at: string
}

export interface CustomReport {
  id:                     string
  group_id:               string
  name:                   string
  description:            string | null
  file_path:              string
  file_type:              string
  uploaded_by:            string
  is_active:              boolean
  is_draft:               boolean
  status:                 'draft' | 'published'
  folder_id:              string | null
  sort_order:             number
  is_shareable:           boolean
  share_token:            string | null
  share_token_created_at: string | null
  tags:                   string[]
  agent_run_id:           string | null
  template_id:            string | null
  created_at:             string
  updated_at:             string
}

// ============================================================
// Forecast types  (Phase 2e)
// ============================================================

export interface ForecastStream {
  id:                  string
  group_id:            string
  name:                string
  tag:                 string
  color:               string
  y1_baseline:         number   // cents
  default_growth_rate: number   // integer percentage, e.g. 20 = 20%
  default_gp_margin:   number   // integer percentage, e.g. 40 = 40%
  sort_order:          number
  is_active:           boolean
}

export interface ForecastUserState {
  year:    number
  showGP:  boolean
  showAll: boolean
  rates:   Record<string, { gr: number; gp: number }>
    // key = stream id; gr = growth rate %; gp = GP margin %
}

// ============================================================
// Agent types  (Phase 3a)
// ============================================================

export type AgentModel =
  | 'claude-sonnet-4-20250514'
  | 'claude-opus-4-20250514'
  | 'gpt-4o'

export type AgentTool =
  | 'read_financials'
  | 'generate_report'
  | 'send_slack'
  | 'send_email'
  | 'list_report_templates'
  | 'read_report_template'
  | 'create_report_template'
  | 'update_report_template'
  | 'render_report'
  | 'analyse_document'
  | 'list_documents'
  | 'read_document'
  | 'create_document'
  | 'update_document'
  | 'read_cashflow'
  | 'read_cashflow_items'
  | 'suggest_cashflow_item'
  | 'update_cashflow_item'
  | 'create_cashflow_snapshot'
  | 'summarise_cashflow'
  | 'read_marketing_data'
  | 'summarise_marketing'
  | 'ask_user'
  | 'read_attachment'

export type PersonaPreset =
  | 'executive_analyst'
  | 'business_writer'
  | 'operations_assistant'
  | 'custom'

export type RunStatus =
  | 'queued' | 'running' | 'cancelling' | 'success' | 'error' | 'cancelled' | 'awaiting_input'

export interface Agent {
  id:                    string
  group_id:              string
  name:                  string
  description:           string | null
  avatar_color:          string
  avatar_url:            string | null
  avatar_preset:         string | null
  model:                 AgentModel
  model_provider:        string | null
  model_name:            string | null
  model_api_key:         string | null
  model_config_id:       string | null   // FK → group_model_configs (migration 042, legacy)
  ai_provider:           string | null   // 'anthropic'|'openai'|'google'|'mistral'|'custom' (migration 043)
  ai_model:              string | null   // model name string (migration 043)
  persona_preset:        PersonaPreset
  persona:               string | null
  instructions:          string | null
  tools:                 AgentTool[]
  company_scope:         string[] | null
  email_address:         string | null
  email_display_name:    string | null
  email_recipients:      string[] | null
  slack_channel:         string | null
  is_active:             boolean
  // Migration 031 — visibility + creator
  visibility:            'private' | 'public'
  created_by:            string | null
  // Phase WS3 — personality + scheduling
  communication_style:   'formal' | 'balanced' | 'casual'
  response_length:       'concise' | 'balanced' | 'detailed'
  schedule_enabled:      boolean
  schedule_config:       Record<string, unknown> | null
  last_scheduled_run_at: string | null
  next_scheduled_run_at: string | null
  // Knowledge base (migration 030)
  knowledge_text:        string | null
  knowledge_links:       Array<{ url: string; label?: string }>
  // Notifications (migration 038)
  notify_on_completion:  boolean
  notify_on_output:      boolean
  notify_email:          string | null
  notify_slack_channel:  string | null
  // FK → agent_templates.id (migration 060). Agents created from a
  // template inherit its persona / instructions / skills / knowledge
  // at run time. The template's content is hidden from end users.
  template_id?:          string | null
  created_at:            string
  updated_at:            string
}

export interface AgentTemplate {
  id:                   string
  name:                 string
  slug:                 string
  category:             'legal' | 'financial' | 'marketing' | 'operations' | 'hr' | 'general' | 'technical' | 'compliance'
  description:          string
  summary_capabilities: string
  avatar_preset?:       string | null
  avatar_url?:          string | null
  color?:               string | null
  is_published:         boolean
  is_featured:          boolean
  sort_order:           number
  use_count:            number
  version:              number
  created_at:           string
  updated_at:           string
  // Hidden from users — surface only to super_admin / runner injection
  persona?:             string | null
  instructions?:        string | null
  communication_style?: string | null
  response_length?:     string | null
  default_tools?:       string[]
  default_complexity?:  string
}

export interface PlatformKnowledge {
  id:         string
  title:      string
  slug:       string
  category?:  string | null
  content:    string
  source_url?: string | null
  is_active:  boolean
  created_at: string
  updated_at: string
}

export interface AgentTemplateSkill {
  id:          string
  template_id: string
  skill_id:    string
  sort_order:  number
}

export interface AgentTemplateKnowledge {
  id:            string
  template_id:   string
  knowledge_id:  string
  sort_order:    number
}

export interface AgentCredential {
  id:           string
  agent_id:     string
  name:         string
  key:          string
  description:  string | null
  last_used_at: string | null
  expires_at:   string | null
  is_active:    boolean
  created_at:   string
  // value is NEVER returned to client
}

export interface ToolCallLog {
  tool:        string
  input:       Record<string, unknown>
  output:      string
  timestamp:   string
  duration_ms: number
}

export interface AgentRun {
  id:                string
  agent_id:          string
  group_id:          string
  triggered_by:      'user' | 'schedule' | 'api' | string
  triggered_by_user: string | null
  status:            RunStatus
  input_context: {
    period?:              string
    company_ids?:         string[]
    extra_instructions?:  string
  }
  output:           string | null
  output_type:      string
  tool_calls:       ToolCallLog[]
  model_used:       string | null
  tokens_used:      number | null
  error_message:    string | null
  draft_report_id:         string | null
  cancellation_requested:  boolean
  cancelled_at:            string | null
  awaiting_input_question: string | null
  awaiting_input_at:       string | null
  started_at:              string | null
  completed_at:            string | null
  // Per-run notification overrides (migration 038)
  notify_email:            string | null
  notify_slack_channel:    string | null
  // Per-run linked documents (migration 042) — UUIDs of NavHub documents
  // pulled into agent_run_attachments at run start.
  linked_document_ids:     string[]
  // Per-run complexity tier (migration 052) — drives iteration cap, token budget
  // and tool-failure tolerance.
  task_complexity:         TaskComplexity
  created_at:              string
}

export type TaskComplexity = 'standard' | 'medium' | 'large' | 'massive' | 'professional'

export interface TaskComplexitySettings {
  maxIterations:   number
  maxTokens:       number
  maxToolFailures: number
  /** When true, all linked documents + run attachments are inlined into
   *  the system prompt before the agentic loop starts. The agent can
   *  reference them by name without calling read_document / read_attachment. */
  preloadContext:  boolean
}

export const TASK_COMPLEXITY_SETTINGS: Record<TaskComplexity, TaskComplexitySettings> = {
  standard:     { maxIterations: 15,  maxTokens: 16_000, maxToolFailures: 3,  preloadContext: false },
  medium:       { maxIterations: 25,  maxTokens: 32_000, maxToolFailures: 4,  preloadContext: false },
  large:        { maxIterations: 40,  maxTokens: 48_000, maxToolFailures: 5,  preloadContext: false },
  massive:      { maxIterations: 60,  maxTokens: 64_000, maxToolFailures: 6,  preloadContext: false },
  professional: { maxIterations: 999, maxTokens: 64_000, maxToolFailures: 10, preloadContext: true  },
}

/** Tier ordering for "is X allowed under cap Y?" checks on the run launcher. */
export const TASK_COMPLEXITY_ORDER: TaskComplexity[] =
  ['standard', 'medium', 'large', 'massive', 'professional']

export interface AgentRunMessage {
  id:         string
  run_id:     string
  role:       'user' | 'assistant'
  content:    string
  created_at: string
}

export interface AgentRunInteraction {
  id:          string
  run_id:      string
  question:    string
  answer:      string | null
  answered_at: string | null
  created_at:  string
}

export interface ScheduledRunLog {
  id:           string
  agent_id:     string
  run_id:       string | null
  scheduled_at: string
  triggered_at: string | null
  status:       'pending' | 'triggered' | 'failed' | 'skipped'
  error:        string | null
  created_at:   string
}

export const PERSONA_PRESETS: Record<PersonaPreset, string> = {
  executive_analyst:
    'You communicate in a formal, concise tone suited for executive audiences. ' +
    'Lead with key numbers and insights. Structure responses with an executive ' +
    'summary first, detail second. Flag risks clearly without being alarmist. Be direct.',
  business_writer:
    'You write in clear, engaging prose with a professional but approachable tone. ' +
    'Use narrative structure to tell the story behind the numbers. Avoid jargon. ' +
    'Make complex financial information accessible to non-finance readers.',
  operations_assistant:
    'You are practical and action-oriented. Use bullet points and checklists. ' +
    'Prioritise next steps and actionable recommendations. Keep responses concise. ' +
    'Flag blockers and dependencies clearly.',
  custom: '',
}

export const MODEL_OPTIONS: Array<{
  value:       AgentModel
  label:       string
  description: string
  tier:        'standard' | 'advanced' | 'external'
}> = [
  {
    value:       'claude-sonnet-4-20250514',
    label:       'Claude Sonnet 4',
    description: 'Fast and cost-effective. Best for routine tasks.',
    tier:        'standard',
  },
  {
    value:       'claude-opus-4-20250514',
    label:       'Claude Opus 4',
    description: 'Most capable. Best for complex analysis.',
    tier:        'advanced',
  },
  {
    value:       'gpt-4o',
    label:       'GPT-4o',
    description: 'OpenAI model. Requires OPENAI_API_KEY credential.',
    tier:        'external',
  },
]

// ============================================================
// Report Template types  (Phase 5a)
// ============================================================

export type TemplateType = 'financial' | 'matrix' | 'narrative' | 'dashboard' | 'workflow'
export type SlotType = 'text' | 'html' | 'number' | 'table' | 'list' | 'date' | 'color' | 'object'
export type SlotDataSource = 'navhub_financial' | 'manual' | 'uploaded_file' | 'agent_provided'

export interface SlotDefinition {
  name:         string
  label:        string
  type:         SlotType
  description:  string
  required:     boolean
  default?:     unknown
  data_source:  SlotDataSource
  navhub_query?: {
    type:       string
    period:     string
    companies?: string[]
  }
}

export interface DataSourceConfig {
  type:        SlotDataSource
  description: string
}

export interface ReportTemplate {
  id:                 string
  group_id:           string
  name:               string
  description:        string | null
  template_type:      TemplateType
  version:            number
  design_tokens:      Record<string, string>
  slots:              SlotDefinition[]
  scaffold_html:      string | null
  scaffold_css:       string | null
  scaffold_js:        string | null
  data_sources:       DataSourceConfig[]
  agent_instructions: string | null
  created_by:         string | null
  agent_run_id:       string | null
  is_active:          boolean
  created_at:         string
  updated_at:         string
}

export interface ReportTemplateVersion {
  id:            string
  template_id:   string
  version:       number
  design_tokens: Record<string, string> | null
  slots:         SlotDefinition[] | null
  scaffold_html: string | null
  scaffold_css:  string | null
  scaffold_js:   string | null
  saved_by:      string | null
  created_at:    string
}

// ============================================================
// Cash Flow Forecast types  (Phase 4a)
// ============================================================

export type CashflowSection = 'inflow' | 'regular_outflow' | 'payable'
export type CashflowRecurrence = 'weekly' | 'fortnightly' | 'monthly' | 'one_off'

export interface CashflowSettings {
  company_id:            string
  opening_balance_cents: number   // bigint cents
  week_start_day:        number   // 0=Sun, 1=Mon … 6=Sat
  ar_lag_days:           number
  ap_lag_days:           number
  currency:              string
  bank_account_id:       string | null   // Xero bank account ID (Phase 4b)
  updated_at:            string
}

export interface CashflowItem {
  id:             string
  company_id:     string
  label:          string
  section:        CashflowSection
  amount_cents:   number
  recurrence:     CashflowRecurrence
  start_date:     string   // ISO date "YYYY-MM-DD"
  end_date:       string | null
  day_of_week:    number | null   // 0=Sun … 6=Sat; used by weekly/fortnightly
  day_of_month:   number | null   // 1–31; used by monthly
  pending_review: boolean
  is_active:      boolean
  created_at:     string
  updated_at:     string
}

export interface CashflowXeroItem {
  id:                string
  company_id:        string
  // legacy columns (stub from migration 009)
  xero_invoice_id:   string
  contact_name:      string | null
  amount_cents:      number | null
  due_date:          string | null
  section:           'inflow' | 'payable'
  is_overridden:     boolean
  created_at:        string
  // Phase 4b columns (migration 017)
  xero_contact_name: string | null
  xero_due_date:     string | null   // ISO date "YYYY-MM-DD"
  xero_amount_due:   number | null   // bigint cents
  invoice_type:      'AR' | 'AP' | null
  sync_status:       'pending' | 'synced' | 'overridden' | 'excluded'
  overridden_week:   string | null   // ISO date — which week to move the item to
  overridden_amount: number | null   // bigint cents — override the amount
  last_synced_at:    string | null
}

export interface CashflowForecast {
  company_id: string
  grid_data:  ForecastGrid
  saved_at:   string
}

export interface CashflowSnapshot {
  id:         string
  company_id: string
  name:       string
  notes:      string | null
  grid_data:  ForecastGrid
  created_by: string
  created_at: string
}

export interface ForecastRow {
  item_id:        string | null
  label:          string
  amounts_cents:  number[]   // one value per week (13 values)
  is_editable:    boolean
  pending_review: boolean
  // Phase 4b — Xero-sourced rows
  xero_source?:       boolean
  xero_contact?:      string | null
  xero_invoice_id?:   string | null
  xero_sync_status?:  'pending' | 'synced' | 'overridden' | 'excluded'
}

export interface ForecastSection {
  rows:      ForecastRow[]
  subtotals: number[]   // one value per week
}

export interface ForecastGrid {
  weeks: string[]   // ISO date strings — week start dates (13 entries)
  sections: {
    inflows:        ForecastSection
    regularOutflows: ForecastSection
    payables:       ForecastSection
  }
  summary: {
    netCashFlow:    number[]
    openingBalance: number[]
    closingBalance: number[]
  }
}

// ============================================================
// Document Intelligence types  (Phase 7a)
// ============================================================

export type DocumentType =
  | 'general'
  | 'financial_analysis'
  | 'cash_flow_review'
  | 'board_report'
  | 'budget_vs_actual'
  | 'job_description'
  | 'org_structure'
  | 'entity_relationship'
  | 'business_health'
  | 'tax_position'
  | 'due_diligence'
  | 'investor_briefing'

export type DocumentAudience =
  | 'board'
  | 'management'
  | 'investor'
  | 'internal'
  | 'hr'
  | 'external'

export interface DocumentFolder {
  id:          string
  group_id:    string
  name:        string
  is_system:   boolean
  folder_type: 'general' | 'templates' | 'imports'
  created_by:  string | null
  created_at:  string
}

export interface KnowledgeLink {
  url:          string
  label:        string
  description?: string
}

// ── Group-level model configuration (migration 042) ──
export type ModelProvider = 'anthropic' | 'openai' | 'google' | 'mistral' | 'custom'

export interface GroupModelConfig {
  id:                 string
  group_id:           string
  label:              string
  provider:           ModelProvider | string
  model_name:         string
  api_key_encrypted?: string   // never sent to client; present in DB only
  is_default:         boolean
  is_active:          boolean
  created_at:         string
}

export interface GroupAgentKnowledge {
  id:              string
  group_id:        string
  knowledge_text:  string | null
  knowledge_links: KnowledgeLink[]
  updated_at:      string
}

export interface GroupAgentKnowledgeDocument {
  id:              string
  group_id:        string
  document_id:     string | null
  file_path:       string | null
  file_name:       string
  file_type:       string | null
  created_at:      string
  document_title?: string | null
}

// ── Assistant configuration (admin) ──
export interface AssistantConfig {
  id?:                  string
  persona_name:         string
  persona_tone?:        string
  persona_instructions: string | null
  scope_text:           string | null
  knowledge_text:       string | null
  restrictions:         string | null
  is_active?:           boolean
  updated_at?:          string
}

export interface KnowledgeDoc {
  id:             string
  group_id:       string | null
  document_id:    string | null
  file_path:      string | null
  file_name:      string
  file_type:      string | null
  document_title: string | null
}

export interface AgentKnowledgeDocument {
  id:              string
  agent_id:        string
  document_id:     string | null
  /** When set, this knowledge entry references a custom_report (migration 049) */
  report_id?:      string | null
  file_path:       string | null
  file_name:       string
  file_type:       string | null
  file_size:       number | null
  created_at:      string
  document_title?: string | null
}

// ── Custom webhook tools (migration 040) ──
export interface ToolParameter {
  name:        string
  type:        'string' | 'number' | 'boolean' | 'array'
  required:    boolean
  description: string
}

export interface CustomTool {
  id:          string
  group_id:    string
  name:        string
  label:       string
  description: string
  webhook_url: string
  http_method: 'GET' | 'POST' | 'PUT' | 'PATCH'
  headers:     Record<string, string>
  parameters:  ToolParameter[]
  is_active:   boolean
  created_by:  string | null
  created_at:  string
  updated_at:  string
}

export interface AgentToolOverride {
  id:         string
  agent_id:   string
  tool_name:  string
  enabled:    boolean
  created_at: string
}

export interface Document {
  id:                     string
  group_id:               string
  company_id:             string | null
  folder_id:              string | null
  title:                  string
  document_type:          DocumentType
  audience:               DocumentAudience
  content_markdown:       string
  status:                 'draft' | 'published'
  share_token:            string | null
  is_shareable:           boolean
  share_token_created_at: string | null
  locked_by:              string | null
  locked_at:              string | null
  agent_run_id:           string | null
  created_by:             string | null
  created_at:             string
  updated_at:             string
  tags:                   string[]
  // Document upload fields (migration 027)
  upload_source:          'created' | 'uploaded' | 'agent'
  file_path:              string | null
  file_name:              string | null
  file_size:              number | null
  file_type:              string | null
}

export interface AgentRunAttachment {
  id:           string
  run_id:       string
  file_path:    string
  file_name:    string
  file_type:    string
  file_size:    number | null
  content_text: string | null
  created_at:   string
}

export interface DocumentVersion {
  id:               string
  document_id:      string
  content_markdown: string
  version:          number
  created_by:       string | null
  created_at:       string
}

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  general:            'General Document',
  financial_analysis: 'Financial Analysis',
  cash_flow_review:   'Cash Flow Review',
  board_report:       'Board Report',
  budget_vs_actual:   'Budget vs Actual',
  job_description:    'Job Description',
  org_structure:      'Org Structure',
  entity_relationship:'Entity Relationship',
  business_health:    'Business Health Summary',
  tax_position:       'Tax Position Summary',
  due_diligence:      'Due Diligence Pack',
  investor_briefing:  'Investor Briefing',
}

export const DOCUMENT_AUDIENCE_LABELS: Record<DocumentAudience, string> = {
  board:      'Board',
  management: 'Management',
  investor:   'Investor',
  internal:   'Internal',
  hr:         'HR',
  external:   'External / Client',
}

// ============================================================
// Marketing Intelligence types (Phase 8a)
// ============================================================

export type MarketingPlatform =
  | 'ga4' | 'search_console' | 'meta' | 'linkedin'
  | 'google_ads' | 'meta_ads' | 'mailchimp' | 'hubspot' | 'freshsales'

export const MARKETING_PLATFORM_LABELS: Record<MarketingPlatform, string> = {
  ga4:            'Google Analytics 4',
  search_console: 'Google Search Console',
  meta:           'Meta (Facebook/Instagram)',
  linkedin:       'LinkedIn',
  google_ads:     'Google Ads',
  meta_ads:       'Meta Ads',
  mailchimp:      'Mailchimp',
  hubspot:        'HubSpot',
  freshsales:     'Freshsales',
}

export const MARKETING_PLATFORM_ICONS: Record<MarketingPlatform, string> = {
  ga4:            '📊',
  search_console: '🔍',
  meta:           '📘',
  linkedin:       '💼',
  google_ads:     '🎯',
  meta_ads:       '📣',
  mailchimp:      '🐵',
  hubspot:        '🧡',
  freshsales:     '🌱',
}

export interface MarketingMetricDef {
  key:         string
  label:       string
  type:        'number' | 'percentage' | 'currency'
  description: string
}

export const MARKETING_METRICS: Record<MarketingPlatform, MarketingMetricDef[]> = {
  ga4: [
    { key: 'sessions',             label: 'Sessions',             type: 'number',     description: 'Total website sessions' },
    { key: 'users',                label: 'Users',                type: 'number',     description: 'Unique users' },
    { key: 'new_users',            label: 'New Users',            type: 'number',     description: 'First-time visitors' },
    { key: 'bounce_rate',          label: 'Bounce Rate',          type: 'percentage', description: 'Single-page sessions %' },
    { key: 'avg_session_duration', label: 'Avg Session Duration', type: 'number',     description: 'Seconds' },
    { key: 'conversions',          label: 'Conversions',          type: 'number',     description: 'Goal completions' },
    { key: 'conversion_rate',      label: 'Conversion Rate',      type: 'percentage', description: 'Conversions / sessions' },
  ],
  search_console: [
    { key: 'impressions',   label: 'Impressions',        type: 'number',     description: 'Search result appearances' },
    { key: 'clicks',        label: 'Clicks',             type: 'number',     description: 'Search result clicks' },
    { key: 'ctr',           label: 'Click-Through Rate', type: 'percentage', description: 'Clicks / impressions' },
    { key: 'avg_position',  label: 'Avg Position',       type: 'number',     description: 'Average search ranking' },
  ],
  meta: [
    { key: 'followers',       label: 'Followers',       type: 'number',     description: 'Total page followers' },
    { key: 'reach',           label: 'Reach',           type: 'number',     description: 'Unique accounts reached' },
    { key: 'impressions',     label: 'Impressions',     type: 'number',     description: 'Total post impressions' },
    { key: 'engagement',      label: 'Engagement',      type: 'number',     description: 'Likes, comments, shares' },
    { key: 'engagement_rate', label: 'Engagement Rate', type: 'percentage', description: 'Engagement / reach' },
    { key: 'page_views',      label: 'Page Views',      type: 'number',     description: 'Profile page views' },
  ],
  linkedin: [
    { key: 'followers',       label: 'Followers',       type: 'number',     description: 'Page followers' },
    { key: 'impressions',     label: 'Impressions',     type: 'number',     description: 'Post impressions' },
    { key: 'engagement',      label: 'Engagement',      type: 'number',     description: 'Reactions, comments, shares' },
    { key: 'engagement_rate', label: 'Engagement Rate', type: 'percentage', description: 'Engagement / impressions' },
    { key: 'clicks',          label: 'Clicks',          type: 'number',     description: 'Link clicks' },
  ],
  google_ads: [
    { key: 'spend',       label: 'Spend',       type: 'currency',   description: 'Total ad spend' },
    { key: 'impressions', label: 'Impressions', type: 'number',     description: 'Ad impressions' },
    { key: 'clicks',      label: 'Clicks',      type: 'number',     description: 'Ad clicks' },
    { key: 'ctr',         label: 'CTR',         type: 'percentage', description: 'Click-through rate' },
    { key: 'conversions', label: 'Conversions', type: 'number',     description: 'Ad conversions' },
    { key: 'cpc',         label: 'Avg CPC',     type: 'currency',   description: 'Cost per click' },
    { key: 'roas',        label: 'ROAS',        type: 'number',     description: 'Return on ad spend' },
  ],
  meta_ads: [
    { key: 'spend',       label: 'Spend',       type: 'currency',   description: 'Total ad spend' },
    { key: 'impressions', label: 'Impressions', type: 'number',     description: 'Ad impressions' },
    { key: 'reach',       label: 'Reach',       type: 'number',     description: 'Unique reach' },
    { key: 'clicks',      label: 'Clicks',      type: 'number',     description: 'Link clicks' },
    { key: 'ctr',         label: 'CTR',         type: 'percentage', description: 'Click-through rate' },
    { key: 'conversions', label: 'Conversions', type: 'number',     description: 'Ad conversions' },
    { key: 'cpc',         label: 'Avg CPC',     type: 'currency',   description: 'Cost per click' },
    { key: 'roas',        label: 'ROAS',        type: 'number',     description: 'Return on ad spend' },
  ],
  mailchimp: [
    { key: 'list_size',        label: 'List Size',         type: 'number',     description: 'Total subscribers' },
    { key: 'sends',            label: 'Emails Sent',       type: 'number',     description: 'Total emails sent' },
    { key: 'open_rate',        label: 'Open Rate',         type: 'percentage', description: 'Opens / sends' },
    { key: 'click_rate',       label: 'Click Rate',        type: 'percentage', description: 'Clicks / sends' },
    { key: 'unsubscribe_rate', label: 'Unsubscribe Rate',  type: 'percentage', description: 'Unsubscribes / sends' },
    { key: 'bounce_rate',      label: 'Bounce Rate',       type: 'percentage', description: 'Bounced / sends' },
  ],
  hubspot: [
    { key: 'total_contacts',  label: 'Total Contacts',  type: 'number',   description: 'CRM contact count' },
    { key: 'new_contacts',    label: 'New Contacts',    type: 'number',   description: 'New this period' },
    { key: 'deals_open',      label: 'Open Deals',      type: 'number',   description: 'Active pipeline deals' },
    { key: 'deals_won',       label: 'Deals Won',       type: 'number',   description: 'Closed won this period' },
    { key: 'pipeline_value',  label: 'Pipeline Value',  type: 'currency', description: 'Total open deal value' },
    { key: 'emails_sent',     label: 'Emails Sent',     type: 'number',   description: 'Marketing emails sent' },
    { key: 'email_open_rate', label: 'Email Open Rate', type: 'percentage', description: 'Email opens %' },
  ],
  freshsales: [
    { key: 'total_contacts', label: 'Total Contacts', type: 'number',   description: 'CRM contact count' },
    { key: 'new_contacts',   label: 'New Contacts',   type: 'number',   description: 'New this period' },
    { key: 'deals_open',     label: 'Open Deals',     type: 'number',   description: 'Active pipeline deals' },
    { key: 'deals_won',      label: 'Deals Won',      type: 'number',   description: 'Closed won this period' },
    { key: 'pipeline_value', label: 'Pipeline Value', type: 'currency', description: 'Total open deal value' },
  ],
}

export interface MarketingConnection {
  id:                      string
  group_id:                string
  company_id:              string | null
  platform:                MarketingPlatform
  credentials_encrypted:   string | null
  config:                  Record<string, unknown> | null
  is_active:               boolean
  last_synced_at:          string | null
  created_at:              string
  // Phase 8b additions:
  access_token_expires_at: string | null
  scope:                   string | null
  external_account_id:     string | null
  external_account_name:   string | null
}

export interface MarketingSnapshot {
  id:           string
  group_id:     string
  company_id:   string | null
  platform:     string
  metric_key:   string
  value_number: number | null
  value_text:   string | null
  period_start: string
  period_end:   string
  period_type:  'day' | 'week' | 'month'
  source:       string
  created_by:   string | null
  created_at:   string
}

export interface MarketingDatabaseSnapshot {
  id:                       string
  group_id:                 string
  company_id:               string | null
  platform:                 string
  total_contacts:           number | null
  active_contacts:          number | null
  new_this_period:          number | null
  unsubscribed_this_period: number | null
  snapshot_date:            string
  source:                   string
  notes:                    string | null
  created_at:               string
}

// ============================================================
// Skills (migration 056)
// ============================================================

export type SkillTier = 'platform' | 'group' | 'agent'

export interface Skill {
  id:              string
  tier:            SkillTier
  group_id:        string | null
  name:            string
  slug:            string
  category:        string | null
  description:     string
  instructions:    string
  knowledge_text:  string | null
  examples:        string | null
  tool_grants:     string[]
  is_active:       boolean
  is_published:    boolean
  version:         number
  created_by:      string | null
  created_at:      string
  updated_at:      string
}

export interface SkillKnowledgeDocument {
  id:          string
  skill_id:    string
  document_id: string | null
  file_name:   string
  file_type:   string | null
  created_at:  string
}

export interface AgentSkill {
  id:         string
  agent_id:   string
  skill_id:   string
  sort_order: number
  created_at: string
  skill?:     Skill
}

export interface GroupSkill {
  id:         string
  group_id:   string
  skill_id:   string
  sort_order: number
  created_at: string
  skill?:     Skill
}

// ============================================================
// Sage — platform intelligence agent (migration 058)
// ============================================================

export type SageScanType = 'weekly' | 'daily' | 'adhoc' | 'alert' | 'requested'
export type SageSeverity = 'critical' | 'warning' | 'info' | 'positive'
export type SageActionType = 'operator_can_act' | 'escalate_to_builder' | 'awareness'
export type SageFindingStatus = 'new' | 'acknowledged' | 'acting' | 'resolved' | 'dismissed'
export type SageFindingType =
  'performance' | 'usage' | 'friction' | 'security' | 'feature' | 'health' | 'suggestion' | 'alert'

export interface SageScan {
  id:                  string
  scan_type:           SageScanType
  triggered_by:        string | null
  status:              'running' | 'complete' | 'failed'
  findings_count:      number
  critical_count:      number
  summary:             string | null
  focus_area:          string | null
  period_days:         number | null
  started_at:          string
  completed_at:        string | null
  error_message:       string | null
  // Phase 1: Kaizen contract extensions
  request_id:          string | null
  sage_version:        string | null
  builder_request_at:  string | null
}

export interface SageFinding {
  id:               string
  scan_id:          string | null
  run_id:           string | null
  finding_type:     SageFindingType
  severity:         SageSeverity
  action_type:      SageActionType
  title:            string
  observation:      string
  interpretation:   string
  recommendation:   string | null
  affected_groups:  string[] | null
  affected_count:   number | null
  cluster_key:      string | null
  status:           SageFindingStatus
  dismissed_reason: string | null
  acknowledged_by:  string | null
  acknowledged_at:  string | null
  scan_type:        SageScanType
  period_start:     string | null
  period_end:       string | null
  raw_data:         Record<string, unknown> | null
  created_at:       string
  // Phase 1: escalation tracking
  escalation_id:    string | null
}

export interface UserSuggestion {
  id:              string
  group_id:        string | null
  submitted_by:    string | null
  what_trying:     string
  what_happened:   string
  what_wanted:     string
  category:        'feature_request' | 'bug_report' | 'workflow_friction' | 'knowledge_gap' | 'other' | null
  sage_triage:     Record<string, unknown> | null
  status:          'submitted' | 'triaged' | 'acknowledged' | 'acting' | 'declined' | 'shipped'
  operator_note:   string | null
  user_notified_at: string | null
  sage_finding_id: string | null
  created_at:      string
}

// Phase 1: Unified feedback table
export type FeedbackType = 'support_request' | 'feature_suggestion' | 'user_report'
export type FeedbackStatus = 'submitted' | 'triaged' | 'acknowledged' | 'acting' | 'declined'

export interface Feedback {
  id:         string
  type:       FeedbackType
  body:       string
  user_ref:   string | null
  group_id:   string | null
  status:     FeedbackStatus
  created_at: string
  updated_at: string
}

// Phase 1: Escalation tracking
export type EscalationTriggerType = 'review' | 'user_report' | 'suggestion' | 'admin_interaction'
export type EscalationStatus = 'drafted' | 'sent' | 'acknowledged' | 'acted' | 'declined'

export interface SageEscalation {
  id:                   string
  scan_id:              string | null
  finding_id:           string | null
  trigger_type:         EscalationTriggerType
  summary:              string
  detail:               string
  suggested_priority:   'low' | 'medium' | 'high' | 'critical' | null
  status:               EscalationStatus
  created_at:           string
  sent_at:              string | null
  kaizen_escalation_id: string | null
  build_progress:       Record<string, unknown> | null
}

// ============================================================
// API response types
// ============================================================

export interface ApiResponse<T = unknown> {
  data?: T
  error?: string
}
