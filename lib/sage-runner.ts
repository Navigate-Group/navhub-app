/**
 * Sage — platform intelligence agent (server-side only).
 *
 * Sage runs on a cadence (weekly digest, daily quick scan) and on demand
 * (adhoc, requested with focus area, alert). Each scan:
 *   1. Gathers platform-wide data via the admin Supabase client
 *   2. Builds a structured brief and sends it to Claude Sonnet
 *   3. Parses the model's `---FINDING--- … ---END_FINDING---` blocks
 *   4. Persists findings + a scan summary
 *   5. Optionally fires a Slack alert when there are critical findings
 *
 * RLS: sage_findings + sage_scans are super_admin-only — readers/writers
 * always go through the admin client because Sage operates platform-wide.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { decrypt }          from '@/lib/encryption'
import type { SageScanType, SageSeverity, SageActionType, SageFindingType } from '@/lib/types'
import {
  getContractConfig,
  getSageVersion,
  postReviewResult,
} from '@/lib/sage-contract'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const SAGE_MODEL        = 'claude-sonnet-4-6'
const SAGE_MAX_TOKENS   = 8000

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export interface SageAnalysisContext {
  periodStart: Date
  periodEnd:   Date
  scanType:    SageScanType
  focusArea?:  string | null
}

/**
 * End-to-end orchestration: create the scan row, gather data, call Claude,
 * parse findings, persist, alert. Returns the scan id.
 *
 * Phase 1 extension: accepts optional request_id from Kaizen trigger,
 * sends review-result outbound after scan completes.
 */
export async function runSageScan(
  scanType:    SageScanType,
  triggeredBy: string | null,
  periodDays:  number,
  focusArea?:  string | null,
  requestId?:  string | null,
): Promise<string> {
  const admin = createAdminClient()
  const periodEnd   = new Date()
  const periodStart = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000)

  const { data: scan, error: scanErr } = await admin
    .from('sage_scans')
    .insert({
      scan_type:    scanType,
      triggered_by: triggeredBy,
      status:       'running',
      focus_area:   focusArea ?? null,
      period_days:  periodDays,
      request_id:   requestId ?? null,
      sage_version: getSageVersion(),
    })
    .select('id')
    .single()
  if (scanErr || !scan) throw new Error(`Failed to create scan: ${scanErr?.message}`)
  const scanId = (scan as { id: string }).id

  try {
    const ctx   = { periodStart, periodEnd, scanType, focusArea }
    const data  = await gatherPlatformData(ctx)

    // ── Empty-period guard ───────────────────────────────────────────────
    // If nothing happened in the window the model has nothing to analyse
    // and historically returned malformed output the parser couldn't handle.
    // Short-circuit with a single informational "no activity" finding and
    // a clean summary. Alert scans skip this — they're triggered ON activity
    // so an empty period there is itself meaningful.
    if (data.runs.length === 0 && scanType !== 'alert') {
      const start = periodStart.toISOString().slice(0, 10)
      const end   = periodEnd.toISOString().slice(0, 10)
      const noActivitySummary =
        `No agent runs recorded in this period (${start} to ${end}). Platform appears quiet.`

      await admin.from('sage_findings').insert({
        scan_id:        scanId,
        scan_type:      scanType,
        finding_type:   'health',
        severity:       'info',
        action_type:    'awareness',
        title:          'No activity in this period',
        observation:    `No agent runs were recorded between ${start} and ${end}.`,
        interpretation: 'The platform was not used during this period, or all activity occurred outside the scan window.',
        recommendation: null,
        affected_count: 0,
        period_start:   periodStart.toISOString(),
        period_end:     periodEnd.toISOString(),
      })

      await admin.from('sage_scans').update({
        status:         'complete',
        findings_count: 1,
        critical_count: 0,
        summary:        noActivitySummary,
        completed_at:   new Date().toISOString(),
      }).eq('id', scanId)

      return scanId
    }

    const brief = buildSageBrief(data, ctx)
    const text  = await callClaudeForSage(brief)

    const findings = parseSageFindings(text, scanId, scanType, periodStart, periodEnd)
    if (findings.length > 0) {
      const { error: insErr } = await admin.from('sage_findings').insert(findings)
      if (insErr) console.error('[sage] findings insert failed:', insErr.message)
    } else if (text.length > 100) {
      // Parser returned nothing but the model did respond — log it so the
      // operator notices format drift, but don't fail the scan.
      console.warn('[sage] Parser returned 0 findings; raw response length:', text.length)
    }

    const summary       = extractSageSummary(text)
    const criticalCount = findings.filter(f => f.severity === 'critical').length
    const now = new Date().toISOString()
    await admin.from('sage_scans').update({
      status:         'complete',
      findings_count: findings.length,
      critical_count: criticalCount,
      summary,
      completed_at:   now,
    }).eq('id', scanId)

    if (criticalCount > 0) {
      void notifySageAlert(scanId, summary, findings.filter(f => f.severity === 'critical'))
    }

    // Phase 1 contract: send review-result to Builder after scan completes
    void sendReviewResultToBuilder(scanId, requestId, scanType, summary, findings, now)

    return scanId
  } catch (err) {
    await admin.from('sage_scans').update({
      status:        'failed',
      error_message: err instanceof Error ? err.message : String(err),
      completed_at:  new Date().toISOString(),
    }).eq('id', scanId)
    throw err
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Data gathering — read-only platform queries
// ────────────────────────────────────────────────────────────────────────────

interface PlatformData {
  runs:         Array<Record<string, unknown>>
  errorRuns:    Array<Record<string, unknown>>
  stuckRuns:    Array<Record<string, unknown>>
  tokenUsage:   Array<Record<string, unknown>>
  groups:       Array<Record<string, unknown>>
  staleInvites: Array<Record<string, unknown>>
  agentRuns:    Array<Record<string, unknown>>
  suggestions:  Array<Record<string, unknown>>
  /** Runs in the most-recent 7 days — separate query so Sage can compare
   *  current health against the wider period and tag stale findings as
   *  "appears resolved" when the last failure was more than 7 days ago. */
  recentRuns:   Array<Record<string, unknown>>
}

export async function gatherPlatformData(ctx: SageAnalysisContext): Promise<PlatformData> {
  const admin = createAdminClient()
  const startMs       = ctx.periodStart.toISOString()
  const stuckCutoff   = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const inviteCutoff  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  // Recent-window query — last 7 days regardless of the scan period.
  const recentCutoff  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [
    runStats, errorRuns, stuckRuns, tokenUsage,
    groupActivity, inviteStatus, agentPerformance, userSuggestions,
    recentRuns,
  ] = await Promise.allSettled([
    admin.from('agent_runs')
      .select('id, status, task_complexity, tokens_used, agent_id, group_id, error_message, created_at, completed_at')
      .gte('created_at', startMs)
      .lte('created_at', ctx.periodEnd.toISOString()),
    admin.from('agent_runs')
      .select('id, error_message, agent_id, group_id, task_complexity, created_at')
      .in('status', ['error', 'failed'])
      .gte('created_at', startMs),
    admin.from('agent_runs')
      .select('id, agent_id, group_id, status, started_at, task_complexity')
      .in('status', ['running', 'queued', 'cancelling'])
      .lt('started_at', stuckCutoff),
    admin.from('agent_runs')
      .select('group_id, tokens_used, task_complexity')
      .gte('created_at', startMs)
      .not('tokens_used', 'is', null),
    admin.from('groups')
      .select('id, name, created_at'),
    admin.from('group_invites')
      .select('id, email, group_id, created_at')
      .is('accepted_at', null)
      .lt('created_at', inviteCutoff),
    admin.from('agent_runs')
      .select('agent_id, status, tokens_used, task_complexity')
      .gte('created_at', startMs),
    admin.from('user_suggestions')
      .select('id, what_trying, what_happened, what_wanted, category, group_id, created_at')
      .eq('status', 'submitted'),
    // Recent 7-day window — used by buildSageBrief to detect whether
    // older failures appear resolved.
    admin.from('agent_runs')
      .select('status, group_id, error_message, created_at')
      .gte('created_at', recentCutoff),
  ])

  const settled = <T>(s: PromiseSettledResult<{ data: T[] | null }>): T[] => {
    return s.status === 'fulfilled' ? (s.value.data ?? []) : []
  }

  return {
    runs:         settled(runStats)         as Array<Record<string, unknown>>,
    errorRuns:    settled(errorRuns)        as Array<Record<string, unknown>>,
    stuckRuns:    settled(stuckRuns)        as Array<Record<string, unknown>>,
    tokenUsage:   settled(tokenUsage)       as Array<Record<string, unknown>>,
    groups:       settled(groupActivity)    as Array<Record<string, unknown>>,
    staleInvites: settled(inviteStatus)     as Array<Record<string, unknown>>,
    agentRuns:    settled(agentPerformance) as Array<Record<string, unknown>>,
    suggestions:  settled(userSuggestions)  as Array<Record<string, unknown>>,
    recentRuns:   settled(recentRuns)       as Array<Record<string, unknown>>,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Brief assembly — structured prompt for Claude
// ────────────────────────────────────────────────────────────────────────────

export function buildSageBrief(data: PlatformData, ctx: SageAnalysisContext): string {
  const runs        = data.runs        as Array<{ status?: string; tokens_used?: number; group_id?: string; created_at?: string }>
  const errorRuns   = data.errorRuns   as Array<{ id?: string; error_message?: string; group_id?: string; created_at?: string }>
  const stuckRuns   = data.stuckRuns   as Array<{ id?: string; group_id?: string; status?: string; started_at?: string }>
  const groups      = data.groups      as Array<{ id?: string; name?: string }>
  const recentRuns  = data.recentRuns  as Array<{ status?: string; group_id?: string; error_message?: string; created_at?: string }>

  // Build a group-id → name lookup so the prompt can show real names and so
  // the failure lines below carry the friendly name instead of a raw UUID
  // prefix (Sage was leaking the UUID into operator-facing findings).
  const groupName = (id: string | undefined): string => {
    if (!id) return 'unknown group'
    const g = groups.find(x => x.id === id)
    return g?.name ?? `unknown (${id.slice(0, 8)})`
  }

  // Per-group failure count — surfaces concentration patterns explicitly so
  // Sage doesn't have to count them itself (and so the clustering rule is
  // easier to follow).
  const failuresByGroup = new Map<string, number>()
  for (const r of errorRuns) {
    if (!r.group_id) continue
    failuresByGroup.set(r.group_id, (failuresByGroup.get(r.group_id) ?? 0) + 1)
  }
  const failureConcentration = Array.from(failuresByGroup.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([gid, n]) => `- ${groupName(gid)}: ${n} failure${n !== 1 ? 's' : ''}`)
    .join('\n') || '- None'

  const totalRuns   = runs.length
  const successRuns = runs.filter(r => r.status === 'success').length
  const failedRuns  = errorRuns.length
  const totalTokens = runs.reduce((sum, r) => sum + (r.tokens_used ?? 0), 0)
  const successPct  = totalRuns > 0 ? Math.round((successRuns / totalRuns) * 100) : 0
  const periodLabel = ctx.scanType === 'daily' ? '24 hours' : `${Math.round((ctx.periodEnd.getTime() - ctx.periodStart.getTime()) / (24 * 60 * 60 * 1000))} days`

  const errorRunLines = errorRuns.slice(0, 10)
    .map(r => `- Run ${(r.id ?? '').slice(0, 8)}: ${(r.error_message ?? 'no error message').slice(0, 120)} — group: ${groupName(r.group_id)}`)
    .join('\n') || '- None'

  const stuckLines = stuckRuns
    .map(r => `- Run ${(r.id ?? '').slice(0, 8)}: ${r.status}, started ${r.started_at} — group: ${groupName(r.group_id)}`)
    .join('\n') || '- None'

  const groupIdMap = groups
    .filter(g => g.id && g.name)
    .map(g => `   ${g.id} = "${g.name}"`)
    .join('\n') || '   (no groups)'

  // ── Recent 7-day comparison ─────────────────────────────────────────────
  // Tells Sage whether long-tail failures still recur. The "last failure
  // date" lets it tag stale findings as "appears resolved" when the most
  // recent error is >7 days old and recent runs are clean.
  const recentTotal   = recentRuns.length
  const recentFailed  = recentRuns.filter(r => r.status && ['error', 'failed'].includes(r.status)).length
  const recentSuccess = recentTotal - recentFailed
  const errorTimestamps = errorRuns
    .map(r => r.created_at)
    .filter((s): s is string => typeof s === 'string')
    .sort()
  const lastFailureDate = errorTimestamps.length > 0 ? errorTimestamps[errorTimestamps.length - 1].slice(0, 10) : null

  let recentHealthLine: string
  if (recentTotal === 0)        recentHealthLine = '— No recent activity in the last 7 days'
  else if (recentFailed === 0)  recentHealthLine = '✓ No failures in the last 7 days — earlier issues may be resolved'
  else                          recentHealthLine = `⚠ ${recentFailed} failure(s) in the last 7 days`

  return `You are performing a ${ctx.scanType} platform analysis for NavHub.
Period: ${ctx.periodStart.toISOString().slice(0, 10)} to ${ctx.periodEnd.toISOString().slice(0, 10)} (${periodLabel})
${ctx.focusArea ? `Focus area: ${ctx.focusArea}` : ''}

## Platform Data Summary

### Agent Runs (last ${periodLabel})
- Total runs: ${totalRuns}
- Successful: ${successRuns} (${successPct}%)
- Failed/errored: ${failedRuns}
- Currently stuck (>30 min): ${stuckRuns.length}
- Total tokens used: ${totalTokens.toLocaleString()}

### Failures by group
${failureConcentration}

### Failed Runs (sample)
${errorRunLines}

### Stuck Runs
${stuckLines}

### Platform Health
- Groups: ${groups.length}
- Stale invites (>7 days pending): ${data.staleInvites.length}
- Unreviewed user suggestions: ${data.suggestions.length}

### Recent 7-day health (within the full period above)
- Total runs (last 7 days):     ${recentTotal}
- Successful:                   ${recentSuccess}
- Failed:                       ${recentFailed}
- Last failure date in period:  ${lastFailureDate ?? '— none —'}
${recentHealthLine}

IMPORTANT: If the full-period failures cluster on dates MORE THAN 7 days
ago AND the last 7 days show no failures, downgrade severity to WARNING
or INFO and note the issue "appears resolved as of ${lastFailureDate ?? '[date]'}".
Do NOT raise CRITICAL findings for issues whose most recent occurrence
is more than a week old.

### Group ID → name map (use names in findings, never raw IDs)
${groupIdMap}

## Your Task

Analyse this data and produce structured findings.

CRITICAL RULES (these are non-negotiable — findings that violate them are useless):

1. CLUSTER aggressively. If three runs failed with the same error in the same
   group, that is ONE finding with affected_count: 3 — not three findings,
   not the same root cause from three different angles. Look at the
   "Failures by group" breakdown above before deciding what to report.

2. RESOLVE every group ID to its name. Use the map above. Never leak a raw
   UUID into a title, observation, interpretation or recommendation. If you
   reference a group, write its name.

3. TAG actions correctly:
   - OPERATOR_CAN_ACT: config changes, cancelling stuck runs, adjusting
     agent settings, reviewing per-agent / per-group setup, raising a tier
     cap, asking a user a question. Most timeout, stuck-run and config
     issues live here.
   - ESCALATE_TO_BUILDER: code changes needed, new feature work,
     architectural changes, library upgrades.
   - AWARENESS: informational only, no action required.
   Default to OPERATOR_CAN_ACT unless the only fix is a code change.

4. INCLUDE at least one POSITIVE finding if any groups are running cleanly
   (e.g. "Group X completed 12 runs with no failures this period").
   Operators need to know what's working, not just what's broken.

5. PRIORITISE by impact. One finding describing eight failures outweighs
   four findings about the same eight failures from different angles.

6. BE SPECIFIC. Use exact numbers, exact group names, name specific agents
   when the data identifies them, quote the actual error string from the
   failed runs.

## Output format

Emit each finding as:

---FINDING---
type: performance | usage | friction | security | feature | health | suggestion | alert
severity: critical | warning | info | positive
action: OPERATOR_CAN_ACT | ESCALATE_TO_BUILDER | AWARENESS
title: <concise title under 80 chars — use group names not IDs>
observation: <factual — what you saw in the data, with specific numbers>
interpretation: <analytical — what it means>
recommendation: <specific actionable next step, or "null" if action is AWARENESS>
affected_count: <integer count of groups/users/runs affected, or 0>
---END_FINDING---

After all findings, end with:

---SUMMARY---
<2–3 sentence overall platform health assessment with key metrics>
---END_SUMMARY---
`
}

// ────────────────────────────────────────────────────────────────────────────
// Claude call (non-streaming — we just need the parsed result)
// ────────────────────────────────────────────────────────────────────────────

async function callClaudeForSage(brief: string): Promise<string> {
  // Resolve API key: superadmin_provider_configs → env
  const admin = createAdminClient()
  let apiKey: string | undefined

  // Check superadmin default Anthropic config
  const { data: superRow } = await admin
    .from('superadmin_provider_configs')
    .select('api_key_encrypted')
    .eq('provider', 'anthropic')
    .eq('is_active', true)
    .maybeSingle()
  if (superRow) {
    try { apiKey = decrypt(superRow.api_key_encrypted as string) } catch { /* keep undefined */ }
  }

  // Fall back to env
  if (!apiKey) {
    apiKey = process.env.ANTHROPIC_API_KEY
  }

  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 240_000)

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      SAGE_MODEL,
        max_tokens: SAGE_MAX_TOKENS,
        system:     'You are Sage, the platform intelligence agent for NavHub. You have read access to platform-wide data across all groups. Your role is to observe patterns, identify friction, spot opportunities, and surface clear recommendations to the platform operator. Always structure findings as observation → interpretation → recommendation. Cluster similar issues. Prioritise by impact.',
        messages:   [{ role: 'user', content: brief }],
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`Anthropic API ${res.status}: ${errBody.slice(0, 300)}`)
    }
    const json = await res.json() as { content: Array<{ type: string; text?: string }> }
    return json.content.map(c => c.text ?? '').join('')
  } finally {
    clearTimeout(timer)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Parsers
// ────────────────────────────────────────────────────────────────────────────

interface ParsedFindingRow {
  scan_id:         string
  finding_type:    SageFindingType
  severity:        SageSeverity
  action_type:     SageActionType
  title:           string
  observation:     string
  interpretation:  string
  recommendation:  string | null
  affected_count:  number | null
  scan_type:       SageScanType
  period_start:    string
  period_end:      string
}

const FINDING_TYPES: SageFindingType[] = [
  'performance','usage','friction','security','feature','health','suggestion','alert',
]
const SEVERITIES: SageSeverity[] = ['critical','warning','info','positive']

function normaliseAction(raw: string | null): SageActionType {
  const v = (raw ?? '').toLowerCase().trim()
  if (v === 'operator_can_act' || v === 'operator can act') return 'operator_can_act'
  if (v === 'escalate_to_builder' || v === 'escalate to builder') return 'escalate_to_builder'
  return 'awareness'
}

export function parseSageFindings(
  output:      string,
  scanId:      string,
  scanType:    SageScanType,
  periodStart: Date,
  periodEnd:   Date,
): ParsedFindingRow[] {
  const findings: ParsedFindingRow[] = []
  const blocks = output.split('---FINDING---').slice(1)

  for (const raw of blocks) {
    const block = raw.split('---END_FINDING---')[0]
    if (!block) continue

    // Extract single-line fields. The model occasionally puts these inline.
    const get = (key: string): string | null => {
      const m = block.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'mi'))
      return m ? m[1].trim() : null
    }

    // Multi-line fields run from `key:` until the next `key:` or the end.
    // Pulls everything after the colon, stopping at the next recognised key.
    const KEYS = ['type','severity','action','title','observation','interpretation','recommendation','affected_count']
    const getMulti = (key: string): string | null => {
      const re = new RegExp(`^\\s*${key}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:${KEYS.join('|')})\\s*:|$)`, 'mi')
      const m  = block.match(re)
      return m ? m[1].trim() : null
    }

    const typeRaw     = (get('type')     ?? 'health').toLowerCase().trim()
    const severityRaw = (get('severity') ?? 'info').toLowerCase().trim()
    const finding_type: SageFindingType = (FINDING_TYPES as string[]).includes(typeRaw)
      ? typeRaw as SageFindingType
      : 'health'
    const severity: SageSeverity = (SEVERITIES as string[]).includes(severityRaw)
      ? severityRaw as SageSeverity
      : 'info'

    const recRaw = getMulti('recommendation')
    const recommendation = !recRaw || recRaw.toLowerCase() === 'null' ? null : recRaw

    const affectedRaw = get('affected_count')
    const affectedNum = affectedRaw ? parseInt(affectedRaw, 10) : NaN

    findings.push({
      scan_id:        scanId,
      finding_type,
      severity,
      action_type:    normaliseAction(get('action')),
      title:          (get('title') ?? 'Untitled finding').slice(0, 240),
      observation:    getMulti('observation')    ?? '',
      interpretation: getMulti('interpretation') ?? '',
      recommendation,
      affected_count: Number.isFinite(affectedNum) && affectedNum > 0 ? affectedNum : null,
      scan_type:      scanType,
      period_start:   periodStart.toISOString(),
      period_end:     periodEnd.toISOString(),
    })
  }

  return findings
}

export function extractSageSummary(output: string): string {
  const m = output.match(/---SUMMARY---\s*([\s\S]*?)\s*---END_SUMMARY---/i)
  return m ? m[1].trim() : ''
}

// ────────────────────────────────────────────────────────────────────────────
// Slack alert (best-effort — never throws)
// ────────────────────────────────────────────────────────────────────────────

async function notifySageAlert(
  scanId:           string,
  summary:          string,
  criticalFindings: ParsedFindingRow[],
): Promise<void> {
  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.navhub.co'
    const lines  = criticalFindings
      .slice(0, 5)
      .map(f => `• *${f.title}* — ${f.observation.slice(0, 200)}`)
      .join('\n')

    const text = `:rotating_light: *Sage critical findings* (${criticalFindings.length})\n${lines}\n\n${summary}\n\n<${appUrl}/admin/sage|Open Sage →>`
    console.log('[sage-alert]', { scanId, criticalCount: criticalFindings.length, text })

    // Slack webhook delivery hooks into the existing `slack_connections`
    // infrastructure — best-effort only, keep silent on failure.
    const admin = createAdminClient()
    const { data: superAdmins } = await admin
      .from('user_groups')
      .select('group_id')
      .eq('role', 'super_admin')
      .limit(1)

    const sg = superAdmins?.[0] as { group_id?: string } | undefined
    if (!sg?.group_id) return

    const { data: slackConn } = await admin
      .from('slack_connections')
      .select('access_token, default_channel')
      .eq('group_id', sg.group_id)
      .eq('is_active', true)
      .single()
    if (!slackConn) return
    const conn = slackConn as { access_token?: string; default_channel?: string | null }
    if (!conn.access_token || !conn.default_channel) return

    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${conn.access_token}`,
      },
      body: JSON.stringify({
        channel: conn.default_channel,
        text,
      }),
    }).catch(() => {})
  } catch (err) {
    console.error('[sage-alert] notify failed:', err)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Contract outbound: review-result (Phase 1)
// ────────────────────────────────────────────────────────────────────────────

async function sendReviewResultToBuilder(
  scanId:     string,
  requestId:  string | null | undefined,
  scanType:   SageScanType,
  summary:    string,
  findings:   ParsedFindingRow[],
  ranAt:      string,
): Promise<void> {
  try {
    const config = await getContractConfig()
    const payload = {
      request_id:  requestId ?? null,
      review_type: scanType,
      summary,
      findings:    findings.slice(0, 20).map(f => ({
        severity:       f.severity,
        title:          f.title,
        observation:    f.observation,
        interpretation: f.interpretation,
        recommendation: f.recommendation,
        affected_count: f.affected_count,
      })),
      ran_at:       ranAt,
      sage_version: getSageVersion(),
    }

    await postReviewResult(config, payload)

    // Mark scan as sent to Builder
    const admin = createAdminClient()
    await admin
      .from('sage_scans')
      .update({ builder_request_at: new Date().toISOString() })
      .eq('id', scanId)

    console.log('[sage-contract] Sent review-result to Builder', { scanId, requestId })
  } catch (err) {
    // Best-effort delivery — log but don't throw
    console.error('[sage-contract] Failed to send review-result:', err instanceof Error ? err.message : String(err))
  }
}
