-- Migration 072: Markets data model, RLS & storage (MKT-2)
-- ──────────────────────────────────────────────────────────────────────────
-- The trusted data layer for Markets. Establishes every reference and fact
-- table behind the Markets explorer and agent tools, each row-level-security
-- gated to the Markets roles introduced in migration 071:
--
--   markets_viewer  → read   (explorer)
--   markets_manager → write  (curation) — and read
--   super_admin     → full   (platform super admin, via user_groups)
--
-- Markets is a GLOBAL area (not group-scoped), so these tables are a single
-- shared corpus; access is governed purely by the Markets role, never by
-- group membership. Service-role routes bypass RLS and own the seed/import.
--
-- This file is idempotent — safe to re-run. All statements are guarded.
-- Seed data is loaded separately in migration 073 from markets_sample.json.

-- ── 0. Role helper functions ───────────────────────────────────────────────
-- Centralise the "can this caller read / write Markets" test so every policy
-- stays consistent. SECURITY DEFINER + a pinned search_path so they evaluate
-- against the real tables regardless of the caller's search_path.

CREATE OR REPLACE FUNCTION markets_can_read()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    -- platform super admin → always
    EXISTS (
      SELECT 1 FROM user_groups
      WHERE user_id = auth.uid() AND role = 'super_admin'
    )
    -- OR holds any active Markets grant (viewer or manager)
    OR EXISTS (
      SELECT 1 FROM market_user_roles
      WHERE user_id = auth.uid()
        AND role IN ('markets_viewer', 'markets_manager')
        AND revoked_at IS NULL
    );
$$;

CREATE OR REPLACE FUNCTION markets_can_write()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    -- platform super admin → always
    EXISTS (
      SELECT 1 FROM user_groups
      WHERE user_id = auth.uid() AND role = 'super_admin'
    )
    -- OR holds an active markets_manager grant
    OR EXISTS (
      SELECT 1 FROM market_user_roles
      WHERE user_id = auth.uid()
        AND role = 'markets_manager'
        AND revoked_at IS NULL
    );
$$;

-- ── 1. Reference tables ─────────────────────────────────────────────────────

-- commodities: the tradable goods Markets tracks (banana, mango, …). The
-- bulk of per-commodity metadata (codes, valuation methods, farm structure,
-- gap sources, operators list, CRM config) is stored as JSONB verbatim from
-- the source document so the UI and agent tools read one canonical shape.
CREATE TABLE IF NOT EXISTS markets_commodities (
  id               text PRIMARY KEY,                 -- 'banana'
  name             text NOT NULL,                    -- 'Bananas'
  scope_note       text,
  season_basis     text,
  seasons          jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_season   text,
  default_country  text,
  codes            jsonb NOT NULL DEFAULT '[]'::jsonb,
  valuation_methods jsonb NOT NULL DEFAULT '[]'::jsonb,
  structure        jsonb NOT NULL DEFAULT '{}'::jsonb, -- farm classifications + breakdowns + sources per geo
  gap_sources      jsonb NOT NULL DEFAULT '{}'::jsonb, -- per-geo + _default fallback sources for gaps
  crm              jsonb,
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- geo_units: countries and sub-national regions. 'level' distinguishes them;
-- regions carry a 'parent' country id. The world aggregate ('WLD') is NOT a
-- geo_unit — it appears only as an aggregate key in observations.
CREATE TABLE IF NOT EXISTS markets_geo_units (
  id            text PRIMARY KEY,                    -- 'IND', 'IND-00'
  name          text NOT NULL,
  level         text NOT NULL CHECK (level IN ('country', 'region')),
  m49           text,                                -- UN M49 code (countries)
  continent     text,
  zones         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- trade blocs
  parent        text REFERENCES markets_geo_units(id) ON DELETE CASCADE,
  region_type   text,                                -- 'State', 'Province', …
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_markets_geo_units_parent ON markets_geo_units(parent);
CREATE INDEX IF NOT EXISTS idx_markets_geo_units_level  ON markets_geo_units(level);

-- seasons: the periods figures are reported for (calendar years here).
CREATE TABLE IF NOT EXISTS markets_seasons (
  id          text PRIMARY KEY,                      -- '2024'
  label       text NOT NULL,
  start_date  date,
  end_date    date,
  sort_order  integer NOT NULL DEFAULT 0
);

-- measures: the quantities observations carry (production, exports, …),
-- including derived/ratio measures with their numerator/denominator.
CREATE TABLE IF NOT EXISTS markets_measures (
  id            text PRIMARY KEY,                    -- 'production'
  label         text NOT NULL,
  short_label   text,
  unit          text,
  format        text,
  agg           text,                                -- 'sum' | 'ratio'
  numerator     text,                                -- for ratio measures
  denominator   text,
  derived       boolean NOT NULL DEFAULT false,
  caption       text,
  sort_order    integer NOT NULL DEFAULT 0
);

-- sources: provenance for every figure. Keyed by the short source id used
-- across observations, prices, fx and operators.
CREATE TABLE IF NOT EXISTS markets_sources (
  id         text PRIMARY KEY,                       -- 'faostat_2024'
  name       text NOT NULL,
  short      text,
  url        text,
  method     text,
  licence    text,
  vintage    text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── 2. Fact tables ──────────────────────────────────────────────────────────

-- prices: price-series observations (e.g. World Bank import price) used by
-- the "global" valuation method. 'series' identifies the price series.
CREATE TABLE IF NOT EXISTS markets_prices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commodity   text NOT NULL REFERENCES markets_commodities(id) ON DELETE CASCADE,
  series      text NOT NULL,                         -- 'wb_banana_us'
  season      text NOT NULL,
  value       numeric NOT NULL,
  unit        text,
  source      text REFERENCES markets_sources(id) ON DELETE SET NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (commodity, series, season)
);
CREATE INDEX IF NOT EXISTS idx_markets_prices_lookup
  ON markets_prices(commodity, series, season);

-- observations: the core fact table. One row per (geo, commodity, measure,
-- season). 'geo' is a free text key that includes the 'WLD' world aggregate
-- (which is deliberately NOT a geo_unit), so this column is intentionally
-- NOT a foreign key — observations are seeded verbatim from the source.
CREATE TABLE IF NOT EXISTS markets_observations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  geo         text NOT NULL,                         -- 'IND' | 'WLD' | 'IND-00'
  commodity   text NOT NULL REFERENCES markets_commodities(id) ON DELETE CASCADE,
  measure     text NOT NULL,
  season      text NOT NULL,
  value       numeric NOT NULL,
  source      text REFERENCES markets_sources(id) ON DELETE SET NULL,
  confidence  text,                                  -- 'high' | 'medium' | 'low'
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_markets_observations_lookup
  ON markets_observations(commodity, measure, season, geo);
CREATE INDEX IF NOT EXISTS idx_markets_observations_geo
  ON markets_observations(geo);

-- fx: foreign-exchange rates used to convert local producer prices to USD.
CREATE TABLE IF NOT EXISTS markets_fx (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pair      text NOT NULL,                           -- 'USD per AUD'
  season    text NOT NULL,
  rate      numeric NOT NULL,
  source    text REFERENCES markets_sources(id) ON DELETE SET NULL,
  note      text,
  UNIQUE (pair, season)
);

-- structure: farm classifications, operator breakdowns and gap sources per
-- (commodity, geography). Stored as JSONB verbatim; mirrors the per-geo
-- shape found under commodities.structure in the source document.
CREATE TABLE IF NOT EXISTS markets_structure (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commodity   text NOT NULL REFERENCES markets_commodities(id) ON DELETE CASCADE,
  geo         text NOT NULL,                         -- country id, e.g. 'AUS'
  note        text,
  classifications jsonb NOT NULL DEFAULT '{}'::jsonb,
  breakdowns  jsonb NOT NULL DEFAULT '[]'::jsonb,
  sources     jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (commodity, geo)
);

-- operators: named growers / exporters / associations per commodity. These
-- feed the CRM export and operator lookups.
CREATE TABLE IF NOT EXISTS markets_operators (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commodity   text NOT NULL REFERENCES markets_commodities(id) ON DELETE CASCADE,
  name        text NOT NULL,
  country     text,                                  -- geo id or 'Global'
  region      text,
  ownership   text,
  role        text,
  size        text,
  status      text,                                  -- 'Verified' | 'To verify'
  source      text,                                  -- source id or null
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_markets_operators_commodity
  ON markets_operators(commodity);

-- documents: schema only (no extraction pipeline until MKT-7). Tracks source
-- documents uploaded to the private 'markets-documents' storage bucket.
CREATE TABLE IF NOT EXISTS markets_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL,
  commodity       text REFERENCES markets_commodities(id) ON DELETE SET NULL,
  storage_path    text NOT NULL,                     -- path within the bucket
  mime_type       text,
  size_bytes      bigint,
  status          text NOT NULL DEFAULT 'uploaded'
                    CHECK (status IN ('uploaded', 'processing', 'extracted', 'error')),
  uploaded_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_markets_documents_commodity
  ON markets_documents(commodity);

-- ── 3. Row-level security ───────────────────────────────────────────────────
-- Uniform policy across every Markets table: read-gate to viewer+ (via
-- markets_can_read()), write-gate to manager+ (via markets_can_write()).
-- Service-role routes bypass RLS entirely and own the seed/import path.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'markets_commodities',
    'markets_geo_units',
    'markets_seasons',
    'markets_measures',
    'markets_sources',
    'markets_prices',
    'markets_observations',
    'markets_fx',
    'markets_structure',
    'markets_operators',
    'markets_documents'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I;', t || '_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (markets_can_read());',
      t || '_read', t
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I;', t || '_write', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (markets_can_write()) WITH CHECK (markets_can_write());',
      t || '_write', t
    );
  END LOOP;
END $$;

-- ── 4. Private storage bucket for documents ─────────────────────────────────
-- Managers (+ super admins) can upload; the service role reads for the
-- extraction pipeline (MKT-7). The bucket is private — no public access.

INSERT INTO storage.buckets (id, name, public)
VALUES ('markets-documents', 'markets-documents', false)
ON CONFLICT (id) DO NOTHING;

-- INSERT (upload): managers + super admins only.
DROP POLICY IF EXISTS "markets_documents_upload" ON storage.objects;
CREATE POLICY "markets_documents_upload"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'markets-documents' AND markets_can_write());

-- SELECT (read): managers + super admins through the authenticated path; the
-- service role (extraction pipeline) bypasses RLS and always reads.
DROP POLICY IF EXISTS "markets_documents_read" ON storage.objects;
CREATE POLICY "markets_documents_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'markets-documents' AND markets_can_write());

-- UPDATE / DELETE (manage): managers + super admins only.
DROP POLICY IF EXISTS "markets_documents_manage" ON storage.objects;
CREATE POLICY "markets_documents_manage"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'markets-documents' AND markets_can_write())
  WITH CHECK (bucket_id = 'markets-documents' AND markets_can_write());

DROP POLICY IF EXISTS "markets_documents_delete" ON storage.objects;
CREATE POLICY "markets_documents_delete"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'markets-documents' AND markets_can_write());

-- ── 5. Per-user Markets theme preference ────────────────────────────────────
-- Stored on the existing per-user user_settings row. Options: light | dark |
-- auto (follow device); default auto. Persisted server-side so the choice
-- survives across sessions/devices.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS markets_theme text NOT NULL DEFAULT 'auto'
    CHECK (markets_theme IN ('light', 'dark', 'auto'));
