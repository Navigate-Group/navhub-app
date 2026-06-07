# Sage Phase 1: Contract Alignment & Kaizen Interop — Implementation Summary

## Overview
This implementation aligns NavHub's Sage infrastructure to the canonical Sage↔Kaizen contract spec, unifies feedback tables, instruments error/activity signals, and implements the five contract lanes with HMAC authentication.

## What Was Implemented

### 1. Database Schema (Migrations)

#### Migration 063: Feedback Unification & Kaizen Contract Schema
- **Unified `feedback` table**: Consolidates `support_requests`, `feature_suggestions`, and `user_suggestions` into a single typed table
  - Type enum: `support_request | feature_suggestion | user_report`
  - Status: `submitted | triaged | acknowledged | acting | declined`
  - Includes backfill migration to preserve all existing data
- **Extended `sage_scans`**: Added `request_id`, `sage_version`, `builder_request_at` for Kaizen contract tracking
- **Extended `sage_findings`**: Added `escalation_id` for linking findings to escalations
- **New `sage_escalations` table**: Tracks escalations sent to Builder with status-return support

#### Migration 064: Error & Activity Signal Instrumentation
- **`error_logs` table**: Captures unhandled exceptions, 4xx/5xx responses, DB failures, auth failures
- **`activity_events` table**: Captures flow starts/completions, screen views, drop-offs, retries

### 2. Kaizen Contract Implementation (`lib/sage-contract.ts`)

Implements all five contract lanes with HMAC-SHA256 authentication:

1. **Trigger review (inbound)**: Builder triggers a Sage scan
2. **Review result (outbound)**: Sage sends findings to Builder after scan
3. **Health ping (bidirectional)**: Hourly health check
4. **Escalation (outbound)**: Send critical findings to Builder's Kaizen
5. **Status-return (inbound)**: Builder updates escalation status

**Key functions**:
- `signPayload()`, `verifyHmac()`: HMAC authentication helpers
- `postReviewResult()`, `postHealthPing()`, `postEscalation()`: Outbound POST wrappers
- `getContractConfig()`: Loads `BUILDER_URL`, `SAGE_SHARED_SECRET`, `SAGE_APP_SLUG` from env

### 3. Signal Capture Helpers

#### `lib/signals/error-capture.ts`
- `captureError()`: Log errors to `error_logs` table (best-effort, never throws)
- `withErrorCapture()`: API route wrapper for automatic error logging

#### `lib/signals/activity-capture.ts`
- `captureActivity()`: Emit activity events (best-effort, never throws)

### 4. API Routes

#### `app/api/sage/route.ts` — Inbound Contract Lanes
- `POST /api/sage/trigger`: Accepts review trigger from Builder, queues async scan
- `POST /api/sage/health`: Returns health status (last review, Sage version)
- `POST /api/sage/status-return`: Receives escalation status updates from Builder
- All routes verify HMAC signature via `X-Sage-Signature` header

#### `app/api/cron/sage-health/route.ts`
- Hourly cron job to POST health ping to Builder

### 5. Sage Runner Updates (`lib/sage-runner.ts`)

- **Accepts `requestId` parameter**: Links scans to Kaizen triggers
- **Sets `sage_version`**: Tracks Sage version in scan records
- **Sends review-result outbound**: After scan completes, POSTs findings to Builder
- **Contract integration**: Calls `sendReviewResultToBuilder()` after scan completion

### 6. Admin UI Updates (`app/(admin)/admin/sage/page.tsx`)

**Phase 1 IA**: Tabbed interface with four tabs:
- **Overview**: Latest scan summary, critical findings count, quick actions
- **Feedback**: Redirect to `/admin/suggestions` (unified feedback inbox)
- **Investigations**: Existing findings list (all filters and search preserved)
- **Escalations**: Placeholder for Phase 2 (interactive Requirements frame)

### 7. Middleware & Cron Updates

- **`middleware.ts`**: Added `/api/sage/*` to public routes (Builder needs unauthenticated access)
- **`vercel.json`**: Added hourly cron job for `/api/cron/sage-health`

### 8. Type Definitions (`lib/types.ts`)

Extended existing types and added new ones:
- **`SageScan`**: Added `request_id`, `sage_version`, `builder_request_at`
- **`SageFinding`**: Added `escalation_id`
- **New types**: `Feedback`, `FeedbackType`, `FeedbackStatus`, `SageEscalation`, `EscalationTriggerType`, `EscalationStatus`

## Environment Variables Required

Add to `.env.local` (and production environment):

```bash
# Sage ↔ Kaizen Contract (Phase 1)
BUILDER_URL=https://builder.navhub.co
SAGE_SHARED_SECRET=<shared-secret-here>
SAGE_APP_SLUG=navhub
```

## What Was Preserved

All existing Sage functionality remains intact:
- Weekly/daily/adhoc/alert scan types
- Focus area support
- Findings parsing with `---FINDING---` blocks
- Critical-count alerts
- Slack notifications
- Admin findings management (acknowledge, dismiss, resolve)
- Operator-driven investigation requests

## Out of Scope (Phase 2)

The following are explicitly deferred to a follow-on brief:
- Interactive Requirements frame (status-return UI surfacing)
- Conversational Sage admin surface
- User-facing feedback modals (intake forms remain unchanged)
- Signal backfilling (instrumentation is forward-only)
- Escalation UI (drafted/sent escalations display)

## Testing Checklist

Before shipping:
1. ✅ Run migrations on staging database
2. ⚠ Verify env vars set: `BUILDER_URL`, `SAGE_SHARED_SECRET`, `SAGE_APP_SLUG`
3. ⚠ Test inbound contract lanes with Builder (trigger, health, status-return)
4. ⚠ Verify outbound review-result POST after scan completes
5. ⚠ Check health ping cron runs hourly
6. ✅ Confirm feedback table backfill preserved all data
7. ⚠ Verify admin UI tabs render correctly

## Notes

- **Pre-existing build failure**: The repo has a pre-existing build error in `/app/(admin)/admin/assistant/page.tsx` (missing UI components). This is OUT OF SCOPE per brief rules ("do NOT fix unrelated or pre-existing problems"). The Sage Phase 1 implementation does not introduce new build errors.
- **Contract delivery is best-effort**: Outbound POSTs (review-result, escalation, health) retry 3 times with exponential backoff but log-and-continue on failure (never throw). This prevents scan failures due to Builder downtime.
- **HMAC verification**: All inbound contract lanes verify `X-Sage-Signature` header. Requests with invalid signatures return 401 Unauthorized.
- **Signal instrumentation**: `error_logs` and `activity_events` tables are service-role write-only; super_admin read-only. Helpers never throw (silent failure on logging errors).

## Files Created

- `supabase/migrations/063_sage_feedback_unification.sql`
- `supabase/migrations/064_error_activity_signals.sql`
- `lib/sage-contract.ts`
- `lib/signals/error-capture.ts`
- `lib/signals/activity-capture.ts`
- `app/api/sage/route.ts`
- `app/api/cron/sage-health/route.ts`
- `SAGE_PHASE1_IMPLEMENTATION.md` (this file)

## Files Modified

- `lib/sage-runner.ts` — Added contract integration
- `lib/types.ts` — Extended Sage types, added Feedback + Escalation types
- `middleware.ts` — Allowed public access to `/api/sage/*`
- `vercel.json` — Added health ping cron job
- `app/(admin)/admin/sage/page.tsx` — Added Phase 1 IA tabs

---

**Implementation complete. Ready for review and staging deployment.**
