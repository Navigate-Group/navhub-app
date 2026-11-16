-- Migration 078: Markets global settings & usage cap (MKT-8)
-- ──────────────────────────────────────────────────────────────────────────
-- The admin control surface for Markets (super-admin only) needs a single,
-- editable source of truth for the explorer's GLOBAL display configuration plus
-- the per-user daily token cap that governs the Market Analyst agent. Until now
-- these values were read statically from the bundled markets_sample.json
-- (config.*) with no way for an operator to change them at runtime.
--
-- This migration introduces a SINGLETON settings row (id pinned to 1, mirroring
-- the market_analyst_config pattern in migration 074). Every column is NULLABLE
-- or array-typed with a sensible default; the resolver in lib/markets/settings.ts
-- merges any stored override over the canonical sample defaults, so the explorer
-- keeps working out of the box before an operator ever touches the page.
--
-- Markets is a GLOBAL (not group-scoped) area, so this is a single shared row
-- gated purely by the Markets roles (migration 071) via the markets_can_read()
-- helper (migration 072). WRITES are restricted to platform super admins only —
-- the admin surface uses the service-role client and the route enforces
-- super-admin, so the write policy below is defence-in-depth for the
-- authenticated path.
--
-- This file is idempotent — safe to re-run. All statements are guarded.

-- ── 1. market_settings ─────────────────────────────────────────────────────
-- A single-row (id = 1) record of the operator-tunable global settings.
--
--   headline_measures   → ordered list of measure ids shown as the explorer's
--                         headline cards (and their order).
--   ranking_measures    → ordered list of measure ids offered in the ranking /
--                         map measure selector.
--   ranking_size        → how many rows the ranking lists show.
--   coverage_top_n      → how many countries the coverage table shows.
--   coverage_dimensions → ordered coverage-table columns (JSONB, verbatim shape
--                         from config.coverage_dimensions in the sample doc).
--   default_commodity   → the commodity the explorer opens on.
--   daily_token_cap     → per-user daily Market Analyst token cap. 0 = unlimited.
--   token_alert_percent → % of the cap at which the admin UI flags a user as
--                         "approaching" their cap (0–100).
CREATE TABLE IF NOT EXISTS market_settings (
  id                   integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  headline_measures    jsonb   NOT NULL DEFAULT '[]'::jsonb,
  ranking_measures     jsonb   NOT NULL DEFAULT '[]'::jsonb,
  ranking_size         integer NOT NULL DEFAULT 10  CHECK (ranking_size   > 0),
  coverage_top_n       integer NOT NULL DEFAULT 12  CHECK (coverage_top_n > 0),
  coverage_dimensions  jsonb   NOT NULL DEFAULT '[]'::jsonb,
  default_commodity    text,
  daily_token_cap      integer NOT NULL DEFAULT 0   CHECK (daily_token_cap >= 0),
  token_alert_percent  integer NOT NULL DEFAULT 80  CHECK (token_alert_percent BETWEEN 0 AND 100),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Seed the singleton row if absent. Arrays are left empty / commodity NULL so the
-- resolver falls back to the canonical sample defaults; an operator overrides
-- them through the admin surface. daily_token_cap defaults to 0 (unlimited) so
-- the cap is OFF until an operator deliberately sets one.
INSERT INTO market_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- ── 2. Row-level security ──────────────────────────────────────────────────
-- Read: any Markets viewer+ (so the explorer can resolve effective settings).
-- Write: platform super admins only. The admin surface uses the service-role
-- client (RLS bypass) and the route enforces super-admin; this policy protects
-- the authenticated path as defence-in-depth.

ALTER TABLE market_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS market_settings_read ON market_settings;
CREATE POLICY market_settings_read
  ON market_settings FOR SELECT USING (markets_can_read());

DROP POLICY IF EXISTS market_settings_write ON market_settings;
CREATE POLICY market_settings_write
  ON market_settings FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM user_groups
      WHERE user_id = auth.uid() AND role = 'super_admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_groups
      WHERE user_id = auth.uid() AND role = 'super_admin'
    )
  );
