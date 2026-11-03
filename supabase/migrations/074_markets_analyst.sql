-- Migration 074: Market Analyst backend foundation (MKT-5)
-- ──────────────────────────────────────────────────────────────────────────
-- The data layer for the Market Analyst agent. Three tables:
--
--   market_analyst_cache   → memoises tool/chat results keyed by the view
--                            parameters, with a TTL so stale answers expire.
--   market_analyst_config  → a single-row (id = 1) settings record: whether the
--                            agent is enabled, the model, the system prompt, the
--                            suggested questions and the cache TTL.
--   market_analyst_runs    → one row per agent invocation (tool or chat) for
--                            logging / usage rollups: who asked, the input view
--                            context, the output text, tokens used, duration,
--                            whether it was a cache hit, the run type, tags and
--                            success/error status.
--
-- Markets is a GLOBAL (not group-scoped) area, so these tables are a single
-- shared corpus gated purely by the Markets roles (migration 071) via the
-- markets_can_read() / markets_can_write() helpers (migration 072).
--
-- Service-role routes bypass RLS and own writes to the cache + runs tables.
-- This file is idempotent — safe to re-run. All statements are guarded.

-- ── 1. market_analyst_cache ────────────────────────────────────────────────
-- A memoisation store. The key is constructed deterministically from the view
-- parameters (see lib/markets/analyst-cache.ts) so an identical question maps
-- to the same row. A row is "live" when expires_at > now().
CREATE TABLE IF NOT EXISTS market_analyst_cache (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

-- Primary lookup: fetch a live entry by key. The composite index lets the
-- planner satisfy "key = $1 AND expires_at > now()" from the index alone.
CREATE INDEX IF NOT EXISTS idx_market_analyst_cache_key_expires
  ON market_analyst_cache (key, expires_at);

-- Standalone expiry index for the cleanup sweep (DELETE WHERE expires_at < now()).
CREATE INDEX IF NOT EXISTS idx_market_analyst_cache_expires
  ON market_analyst_cache (expires_at);

-- ── 2. market_analyst_config ───────────────────────────────────────────────
-- A singleton settings row (id is pinned to 1 by a CHECK). The agent prompt,
-- model, suggested questions and cache TTL are all editable (admin config page
-- comes in a later phase); defaults seed the canonical values from
-- markets_sample.json so the agent works out of the box.
CREATE TABLE IF NOT EXISTS market_analyst_config (
  id                   integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled              boolean NOT NULL DEFAULT true,
  model                text NOT NULL DEFAULT 'claude-sonnet-4-6',
  prompt               text,
  suggested_questions  jsonb NOT NULL DEFAULT '[]'::jsonb,
  cache_ttl_hours      integer NOT NULL DEFAULT 24,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Seed the singleton row if absent. Prompt / suggestions are left NULL/empty so
-- the config helper falls back to the canonical values bundled in the sample
-- document; an operator can later override them through the admin surface.
INSERT INTO market_analyst_config (id, enabled, model, cache_ttl_hours)
VALUES (1, true, 'claude-sonnet-4-6', 24)
ON CONFLICT (id) DO NOTHING;

-- ── 3. market_analyst_runs ─────────────────────────────────────────────────
-- One row per agent invocation (tool route or chat). Used for logging, error
-- surfacing and (later) usage rollups. 'input' is the JSON view context the
-- caller supplied; 'output' is the rendered text; 'cached' flags a cache hit.
CREATE TABLE IF NOT EXISTS market_analyst_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  input        jsonb NOT NULL DEFAULT '{}'::jsonb,
  output       text,
  tokens_used  integer NOT NULL DEFAULT 0,
  duration_ms  integer NOT NULL DEFAULT 0,
  cached       boolean NOT NULL DEFAULT false,
  type         text NOT NULL DEFAULT 'market_analyst',
  tags         jsonb NOT NULL DEFAULT '[]'::jsonb,
  status       text NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'error')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_market_analyst_runs_user
  ON market_analyst_runs (user_id);
CREATE INDEX IF NOT EXISTS idx_market_analyst_runs_created
  ON market_analyst_runs (created_at);
CREATE INDEX IF NOT EXISTS idx_market_analyst_runs_status
  ON market_analyst_runs (status);

-- ── 4. Row-level security ──────────────────────────────────────────────────
-- Reuse the markets_can_read()/markets_can_write() helpers (migration 072).
-- Service-role routes bypass RLS and own the writes to cache + runs.
--
--   config  → read: viewer+   | write: manager+
--   cache   → read: viewer+   | write: manager+ (service role owns writes)
--   runs    → read: own rows (a user sees their own history) OR manager+;
--             insert: viewer+ (so a viewer's own run can be logged through the
--             authenticated path); service role owns the actual logging writes.

ALTER TABLE market_analyst_cache  ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_analyst_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_analyst_runs   ENABLE ROW LEVEL SECURITY;

-- config
DROP POLICY IF EXISTS market_analyst_config_read ON market_analyst_config;
CREATE POLICY market_analyst_config_read
  ON market_analyst_config FOR SELECT USING (markets_can_read());

DROP POLICY IF EXISTS market_analyst_config_write ON market_analyst_config;
CREATE POLICY market_analyst_config_write
  ON market_analyst_config FOR ALL
  USING (markets_can_write()) WITH CHECK (markets_can_write());

-- cache
DROP POLICY IF EXISTS market_analyst_cache_read ON market_analyst_cache;
CREATE POLICY market_analyst_cache_read
  ON market_analyst_cache FOR SELECT USING (markets_can_read());

DROP POLICY IF EXISTS market_analyst_cache_write ON market_analyst_cache;
CREATE POLICY market_analyst_cache_write
  ON market_analyst_cache FOR ALL
  USING (markets_can_write()) WITH CHECK (markets_can_write());

-- runs
DROP POLICY IF EXISTS market_analyst_runs_read ON market_analyst_runs;
CREATE POLICY market_analyst_runs_read
  ON market_analyst_runs FOR SELECT
  USING (user_id = auth.uid() OR markets_can_write());

DROP POLICY IF EXISTS market_analyst_runs_insert ON market_analyst_runs;
CREATE POLICY market_analyst_runs_insert
  ON market_analyst_runs FOR INSERT
  WITH CHECK (markets_can_read());
