-- Migration 064: Sage Phase 1 — Error & activity signal instrumentation
--
-- Minimum signal set for Sage to observe errors (unhandled exceptions, API
-- 4xx/5xx, DB write failures, auth failures) and activity (core flow screen
-- views, starts/completions, drop-offs, retries) on priority flows.

-- ── Error logs ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS error_logs (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  route      text        NOT NULL,
  action     text,
  context    jsonb,
  error_type text        NOT NULL,
  message    text        NOT NULL,
  stack      text,
  user_id    uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  group_id   uuid        REFERENCES groups(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_error_logs_created  ON error_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_route    ON error_logs(route, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_type     ON error_logs(error_type);
CREATE INDEX IF NOT EXISTS idx_error_logs_group    ON error_logs(group_id, created_at DESC);

ALTER TABLE error_logs ENABLE ROW LEVEL SECURITY;

-- Service role only for writes (instrumentation from API routes)
-- Super admin read access for Sage
CREATE POLICY "error_logs_select_admin"
  ON error_logs FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM user_groups
    WHERE user_id = auth.uid() AND role = 'super_admin'
  ));

COMMENT ON TABLE error_logs IS 'Lightweight error capture for Sage: API 4xx/5xx, unhandled exceptions, DB write failures, auth failures';

-- ── Activity events ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   text        NOT NULL CHECK (event_type IN (
                 'screen_view', 'flow_start', 'flow_complete', 'flow_drop_off', 'retry'
               )),
  flow         text        NOT NULL,
  screen       text,
  context      jsonb,
  user_id      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  group_id     uuid        REFERENCES groups(id) ON DELETE SET NULL,
  company_id   uuid        REFERENCES companies(id) ON DELETE SET NULL,
  agent_id     uuid        REFERENCES agents(id) ON DELETE SET NULL,
  run_id       uuid        REFERENCES agent_runs(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_events_created   ON activity_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_flow      ON activity_events(flow, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_user      ON activity_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_group     ON activity_events(group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_run       ON activity_events(run_id);

ALTER TABLE activity_events ENABLE ROW LEVEL SECURITY;

-- Service role only for writes
-- Super admin read access for Sage
CREATE POLICY "activity_events_select_admin"
  ON activity_events FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM user_groups
    WHERE user_id = auth.uid() AND role = 'super_admin'
  ));

COMMENT ON TABLE activity_events IS 'Activity capture for Sage: core flow screen views, starts/completions, drop-offs, retries on priority flows (agent runs, company/group management)';
