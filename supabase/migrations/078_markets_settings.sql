-- Migration 078: Markets global settings singleton (MKT-8)
-- ──────────────────────────────────────────────────────────────────────────
-- The admin control surface for the Markets explorer. A SINGLE shared settings
-- row (id pinned to 1 by a CHECK) holds the global explorer configuration a
-- super admin edits from /admin/markets/settings:
--
--   • headline_measures      — which measures appear as headline cards
--   • headline_measure_order — the order the headline cards render in
--   • ranking_size           — rows shown per ranking list (5–20)
--   • coverage_columns       — which coverage dimensions show on the Coverage tab
--   • default_commodity      — the commodity the explorer opens on
--   • daily_token_cap        — per-user daily Market Analyst token budget
--   • alert_threshold_pct    — % of the cap at which an admin alert is raised
--   • reset_timezone         — the timezone the daily cap resets at (Perth)
--
-- DEFAULTS are seeded from markets_sample.json (config.*) so the row matches
-- what the explorer renders today. MKT-8 reads these at request time via a
-- server helper (lib/markets/settings.ts); MKT-8b threads them through
-- compute.ts/explorer.ts/views.ts to replace the reads from markets_sample.json.
--
-- Markets is a GLOBAL (not group-scoped) area, so this is a single shared row
-- gated purely by the Markets roles (migration 071) via the markets_can_read()
-- helper (migration 072). WRITES are restricted to platform super admins — the
-- admin surface owns writes through the service-role client, and this policy is
-- the authenticated-path defence-in-depth gate.
--
-- This file is idempotent — safe to re-run. All statements are guarded.

-- ── 1. market_settings ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS market_settings (
  id                      integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Which measures render as headline cards, in render order. The array IS the
  -- order (headline_measure_order is implicit in the array ordering) — kept as a
  -- single ordered array so the admin UI can reorder by drag/stepper and we
  -- never have to reconcile a separate order list against the membership list.
  headline_measures       jsonb   NOT NULL DEFAULT '["production","value","exports","export_value"]'::jsonb,
  -- Rows shown per ranking list. Constrained to the 5–20 band the brief allows.
  ranking_size            integer NOT NULL DEFAULT 10 CHECK (ranking_size >= 5 AND ranking_size <= 20),
  -- Which coverage dimensions (by label) show on the Coverage tab. An empty
  -- array means "all" — the explorer falls back to the sample's full set.
  coverage_columns        jsonb   NOT NULL DEFAULT '[]'::jsonb,
  -- The commodity the explorer opens on.
  default_commodity       text    NOT NULL DEFAULT 'banana',
  -- Per-user daily Market Analyst token budget. 0 = unlimited (no cap).
  daily_token_cap         integer NOT NULL DEFAULT 200000 CHECK (daily_token_cap >= 0),
  -- % of the cap at which an admin alert is raised (default 80%).
  alert_threshold_pct     integer NOT NULL DEFAULT 80 CHECK (alert_threshold_pct >= 0 AND alert_threshold_pct <= 100),
  -- The timezone the daily cap resets at. Perth has no DST, so a fixed IANA
  -- zone gives a stable "midnight Perth time" boundary.
  reset_timezone          text    NOT NULL DEFAULT 'Australia/Perth',
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Seed the singleton row if absent, with defaults matching markets_sample.json.
INSERT INTO market_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- ── 2. Row-level security ──────────────────────────────────────────────────
-- Reuse the markets_can_read() helper (migration 072) for reads so any Markets
-- user's request-time render can resolve the settings. Writes are super-admin
-- only; the admin surface owns them through the service-role client (RLS
-- bypass), and this policy protects the authenticated path.
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
