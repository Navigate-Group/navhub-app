-- Migration 074: Market Analyst agent config & usage (MKT-5)
-- ──────────────────────────────────────────────────────────────────────────
-- Backs the Market Analyst feature (MKT-5): the user-facing Agent Analysis
-- panel and the two operator surfaces (/admin/markets/agents config and
-- /admin/markets/usage rollup).
--
--   markets_agent_config  → singleton operator config (enable/disable, model,
--                           prompts, suggested questions, cache TTL). Seeded
--                           from the `config.agent` block in markets_sample.json
--                           so the live config matches the MKT-2 seed.
--   markets_agent_usage   → per-run token accounting (tokens per user per
--                           agent), rolled up on the Markets admin dashboard.
--
-- Markets is a GLOBAL area (not group-scoped). Config is a single shared row;
-- usage is a shared append-only ledger. Service-role routes own all writes and
-- bypass RLS; the policies below protect the anon/authenticated paths.
--
-- This file is idempotent — safe to re-run. All statements are guarded.

-- ── 1. markets_agent_config (singleton) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS markets_agent_config (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The analyst agent key. One row per agent; today only 'analyst' exists, but
  -- the column keeps the table open to future Markets agents (Document
  -- Extractor etc.) without a schema change.
  agent_key            text        NOT NULL DEFAULT 'analyst',
  enabled              boolean     NOT NULL DEFAULT true,
  model                text        NOT NULL DEFAULT 'claude-sonnet-4-20250514',
  analysis_prompt      text        NOT NULL DEFAULT '',
  chat_prompt          text        NOT NULL DEFAULT '',
  -- Suggested-question chips, stored as a JSON array of strings.
  suggestions          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- Analysis cache time-to-live, in hours. 0 disables caching.
  cache_ttl_hours      integer     NOT NULL DEFAULT 24,
  updated_by           uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- One config row per agent_key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_markets_agent_config_key
  ON markets_agent_config (agent_key);

ALTER TABLE markets_agent_config ENABLE ROW LEVEL SECURITY;

-- Readable by any Markets reader (the panel needs suggestions + enabled flag);
-- writable by super admins only. Server routes use the service-role client and
-- bypass RLS entirely — these policies protect the authenticated path.
DROP POLICY IF EXISTS "markets_agent_config: markets readers read" ON markets_agent_config;
CREATE POLICY "markets_agent_config: markets readers read"
  ON markets_agent_config FOR SELECT
  USING (markets_can_read());

DROP POLICY IF EXISTS "markets_agent_config: super admin writes" ON markets_agent_config;
CREATE POLICY "markets_agent_config: super admin writes"
  ON markets_agent_config FOR ALL
  USING (
    EXISTS (SELECT 1 FROM user_groups WHERE user_id = auth.uid() AND role = 'super_admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_groups WHERE user_id = auth.uid() AND role = 'super_admin')
  );

-- Seed the singleton 'analyst' row. Prompts/suggestions are left empty here;
-- the application layer falls back to the canonical config.agent block in
-- markets_sample.json when a column is empty, so the seed JSON remains the
-- single source of truth until an operator overrides it in the admin UI.
INSERT INTO markets_agent_config (agent_key, enabled, model, cache_ttl_hours)
VALUES ('analyst', true, 'claude-sonnet-4-20250514', 24)
ON CONFLICT (agent_key) DO NOTHING;

-- ── 2. markets_agent_usage (append-only ledger) ─────────────────────────────
CREATE TABLE IF NOT EXISTS markets_agent_usage (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  agent_key       text        NOT NULL DEFAULT 'analyst',
  -- 'analysis' (headline run) or 'chat' (conversational turn).
  mode            text        NOT NULL DEFAULT 'chat',
  model           text,
  input_tokens    integer     NOT NULL DEFAULT 0,
  output_tokens   integer     NOT NULL DEFAULT 0,
  total_tokens    integer     NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_markets_agent_usage_user
  ON markets_agent_usage (user_id);
CREATE INDEX IF NOT EXISTS idx_markets_agent_usage_created
  ON markets_agent_usage (created_at);

ALTER TABLE markets_agent_usage ENABLE ROW LEVEL SECURITY;

-- Super admins only read the rollup; the service-role client owns all writes.
DROP POLICY IF EXISTS "markets_agent_usage: super admin reads" ON markets_agent_usage;
CREATE POLICY "markets_agent_usage: super admin reads"
  ON markets_agent_usage FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM user_groups WHERE user_id = auth.uid() AND role = 'super_admin')
  );

COMMENT ON TABLE markets_agent_config IS 'Market Analyst operator config (MKT-5): enable, model, prompts, suggestions, cache TTL';
COMMENT ON TABLE markets_agent_usage  IS 'Market Analyst token usage ledger (MKT-5): tokens per user per agent';
