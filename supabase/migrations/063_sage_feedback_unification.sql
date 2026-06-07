-- Migration 063: Sage Phase 1 — Feedback unification & Kaizen contract schema
--
-- Unifies support_requests + feature_suggestions + user_suggestions into a
-- single typed `feedback` table, extends Sage schema for contract interop,
-- and creates sage_escalations tracking for Phase 1 observe→triage→escalate.

-- ── Unified feedback table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feedback (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  type       text        NOT NULL CHECK (type IN ('support_request', 'feature_suggestion', 'user_report')),
  body       text        NOT NULL,
  user_ref   uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  group_id   uuid        REFERENCES groups(id) ON DELETE SET NULL,
  status     text        NOT NULL DEFAULT 'submitted'
              CHECK (status IN ('submitted', 'triaged', 'acknowledged', 'acting', 'declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_type   ON feedback(type);
CREATE INDEX IF NOT EXISTS idx_feedback_group  ON feedback(group_id);

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

-- Users can insert their own feedback
CREATE POLICY "feedback_insert_own"
  ON feedback FOR INSERT
  WITH CHECK (auth.uid() = user_ref);

-- Users see their own feedback
CREATE POLICY "feedback_select_own"
  ON feedback FOR SELECT
  USING (user_ref = auth.uid());

-- Super admins see all feedback
CREATE POLICY "feedback_select_admin"
  ON feedback FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM user_groups
    WHERE user_id = auth.uid() AND role = 'super_admin'
  ));

-- Super admins can update all feedback
CREATE POLICY "feedback_update_admin"
  ON feedback FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM user_groups
    WHERE user_id = auth.uid() AND role = 'super_admin'
  ));

-- ── Backfill from old tables ──────────────────────────────────────────────────
-- Preserve all existing data from support_requests, feature_suggestions, user_suggestions

INSERT INTO feedback (id, type, body, user_ref, group_id, status, created_at, updated_at)
SELECT
  id,
  'support_request' AS type,
  message AS body,
  user_id AS user_ref,
  group_id,
  CASE
    WHEN status = 'open' THEN 'submitted'
    ELSE 'acknowledged'
  END AS status,
  created_at,
  created_at AS updated_at
FROM support_requests
ON CONFLICT (id) DO NOTHING;

INSERT INTO feedback (id, type, body, user_ref, group_id, status, created_at, updated_at)
SELECT
  id,
  'feature_suggestion' AS type,
  suggestion AS body,
  user_id AS user_ref,
  group_id,
  CASE
    WHEN status = 'new' THEN 'submitted'
    WHEN status IN ('triaged', 'acknowledged', 'acting', 'declined', 'shipped') THEN status
    ELSE 'submitted'
  END AS status,
  created_at,
  created_at AS updated_at
FROM feature_suggestions
ON CONFLICT (id) DO NOTHING;

INSERT INTO feedback (id, type, body, user_ref, group_id, status, created_at, updated_at)
SELECT
  id,
  'user_report' AS type,
  what_trying || E'\n\nWhat happened: ' || what_happened || E'\n\nWhat wanted: ' || what_wanted AS body,
  submitted_by AS user_ref,
  group_id,
  CASE
    WHEN status IN ('submitted', 'triaged', 'acknowledged', 'acting', 'declined') THEN status
    WHEN status = 'shipped' THEN 'acknowledged'
    ELSE 'submitted'
  END AS status,
  created_at,
  created_at AS updated_at
FROM user_suggestions
ON CONFLICT (id) DO NOTHING;

-- ── Extend sage_scans for Kaizen contract ────────────────────────────────────
ALTER TABLE sage_scans
  ADD COLUMN IF NOT EXISTS request_id            uuid,
  ADD COLUMN IF NOT EXISTS sage_version          text,
  ADD COLUMN IF NOT EXISTS builder_request_at    timestamptz;

COMMENT ON COLUMN sage_scans.request_id IS 'Kaizen request_id from inbound trigger (nullable, only set when triggered by Builder)';
COMMENT ON COLUMN sage_scans.sage_version IS 'Version identifier sent to Builder in review-result payload';
COMMENT ON COLUMN sage_scans.builder_request_at IS 'Timestamp when review-result was POSTed to Builder';

-- ── Extend sage_findings for escalation tracking ─────────────────────────────
ALTER TABLE sage_findings
  ADD COLUMN IF NOT EXISTS escalation_id uuid;

COMMENT ON COLUMN sage_findings.escalation_id IS 'Links to sage_escalations when this finding was escalated to Kaizen';

-- ── Sage escalations table ────────────────────────────────────────────────────
-- Tracks escalations sent to Builder's Kaizen, including status-return updates
CREATE TABLE IF NOT EXISTS sage_escalations (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id               uuid        REFERENCES sage_scans(id) ON DELETE SET NULL,
  finding_id            uuid        REFERENCES sage_findings(id) ON DELETE SET NULL,
  trigger_type          text        NOT NULL CHECK (trigger_type IN (
                          'review', 'user_report', 'suggestion', 'admin_interaction'
                        )),
  summary               text        NOT NULL,
  detail                text        NOT NULL,
  suggested_priority    text        CHECK (suggested_priority IN ('low', 'medium', 'high', 'critical')),
  status                text        NOT NULL DEFAULT 'drafted'
                        CHECK (status IN ('drafted', 'sent', 'acknowledged', 'acted', 'declined')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  sent_at               timestamptz,
  kaizen_escalation_id  uuid,
  build_progress        jsonb
);

CREATE INDEX IF NOT EXISTS idx_sage_escalations_status    ON sage_escalations(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sage_escalations_scan      ON sage_escalations(scan_id);
CREATE INDEX IF NOT EXISTS idx_sage_escalations_finding   ON sage_escalations(finding_id);

ALTER TABLE sage_escalations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sage_escalations: super admin only"
  ON sage_escalations FOR ALL
  USING (EXISTS (
    SELECT 1 FROM user_groups
    WHERE user_id = auth.uid() AND role = 'super_admin'
  ));

COMMENT ON TABLE sage_escalations IS 'Phase 1 escalation log: findings/reports sent to Builder Kaizen, with status-return tracking';
