-- Migration 075: Markets audit log, review queue & soft-delete (MKT-6)
-- ──────────────────────────────────────────────────────────────────────────
-- The curation foundation for Markets. Three concerns, all gated to the
-- Markets roles via the markets_can_read() / markets_can_write() helpers from
-- migration 072:
--
--   1. archived_at soft-delete columns on every markets_* reference / fact
--      table. Archiving sets archived_at instead of deleting, so a row stays
--      queryable by the audit log and admin restore flows (MKT-6b+) while
--      user-facing dropdowns filter it out with `WHERE archived_at IS NULL`.
--
--   2. markets_audit — an IMMUTABLE append-only log of every reference-data
--      change: who, when, which table, which row id, and the old / new values
--      as JSONB. No UPDATE / DELETE policy is granted, so authenticated callers
--      can only ever INSERT and SELECT; history cannot be rewritten through the
--      authenticated path. (The service role bypasses RLS and owns writes.)
--
--   3. markets_review_queue — pending observations produced by template import
--      (MKT-6d), awaiting a Manager's approve / reject decision before they are
--      promoted into markets_observations.
--
-- Markets is a GLOBAL (not group-scoped) area, so these tables are a single
-- shared corpus gated purely by the Markets role. Service-role routes bypass
-- RLS and own the import / promote writes.
--
-- NOTE ON SCOPE: the originating brief enumerated some table names that do not
-- exist in THIS schema (e.g. markets_locations / markets_regions /
-- markets_economic_zones / markets_series / markets_fx_rates /
-- markets_valuation_methods / markets_structure_notes). The real schema
-- (migration 072) models geography as markets_geo_units, fx as markets_fx,
-- price series inside markets_prices, valuation methods inside
-- markets_commodities.valuation_methods (JSONB), and structure as
-- markets_structure. The intent — "archive every markets_* reference / fact
-- table" — is honoured by applying archived_at to the tables that actually
-- exist, listed explicitly below.
--
-- This file is idempotent — safe to re-run. All statements are guarded.

-- ── 1. Soft-delete columns ─────────────────────────────────────────────────
-- Add archived_at to every markets_* reference / fact table. NULL = live;
-- a timestamp = archived (soft-deleted). Partial indexes keep the common
-- "live rows only" scans cheap. ADD COLUMN IF NOT EXISTS is idempotent.

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
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS archived_at timestamptz;', t
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I (archived_at) WHERE archived_at IS NULL;',
      'idx_' || t || '_live', t
    );
  END LOOP;
END $$;

-- ── 2. markets_audit ───────────────────────────────────────────────────────
-- Append-only log of reference-data changes. One row per change. `target_table`
-- + `row_id` identify what changed; `old_value` / `new_value` capture the
-- before / after as JSONB (either may be NULL for an insert / delete). `action`
-- records the kind of change. `actor_id` is the acting user (NULL if the row
-- survives the user's deletion). Rows are never updated or deleted through the
-- authenticated path — there is deliberately no UPDATE / DELETE policy.
CREATE TABLE IF NOT EXISTS markets_audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action        text NOT NULL CHECK (action IN ('insert', 'update', 'archive', 'restore', 'delete')),
  target_table  text NOT NULL,                      -- 'markets_sources'
  row_id        text NOT NULL,                      -- primary key of the changed row, as text
  old_value     jsonb,                              -- before-image (NULL for insert)
  new_value     jsonb,                              -- after-image  (NULL for delete)
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_markets_audit_target
  ON markets_audit (target_table, row_id);
CREATE INDEX IF NOT EXISTS idx_markets_audit_actor
  ON markets_audit (actor_id);
CREATE INDEX IF NOT EXISTS idx_markets_audit_created
  ON markets_audit (created_at);

-- ── 3. markets_review_queue ────────────────────────────────────────────────
-- Pending observations awaiting a Manager's approval. The import pipeline
-- (MKT-6d) stages a candidate observation here as `payload` (the full proposed
-- markets_observations row shape, as JSONB) with status 'pending'. A Manager
-- then approves (promote into markets_observations) or rejects it; the decision
-- is recorded with the reviewer and timestamp. `submitted_by` is the importer.
CREATE TABLE IF NOT EXISTS markets_review_queue (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payload       jsonb NOT NULL,                     -- proposed observation row
  commodity     text,                               -- denormalised for queue filtering
  source        text,                               -- denormalised source id, if any
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  review_note   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_markets_review_queue_status
  ON markets_review_queue (status);
CREATE INDEX IF NOT EXISTS idx_markets_review_queue_commodity
  ON markets_review_queue (commodity);
CREATE INDEX IF NOT EXISTS idx_markets_review_queue_created
  ON markets_review_queue (created_at);

-- ── 4. Row-level security ──────────────────────────────────────────────────
-- Reuse the markets_can_read()/markets_can_write() helpers (migration 072).
-- Service-role routes bypass RLS and own the privileged writes.
--
--   markets_audit         → read: viewer+ | insert: manager+ (NO update/delete:
--                           the log is immutable through the authenticated path)
--   markets_review_queue  → read: viewer+ | write (insert/update/delete):
--                           manager+

ALTER TABLE markets_audit        ENABLE ROW LEVEL SECURITY;
ALTER TABLE markets_review_queue ENABLE ROW LEVEL SECURITY;

-- audit: readable by viewer+, insert-only for manager+. No UPDATE/DELETE policy
-- is created on purpose, so the history is append-only and cannot be rewritten.
DROP POLICY IF EXISTS markets_audit_read ON markets_audit;
CREATE POLICY markets_audit_read
  ON markets_audit FOR SELECT USING (markets_can_read());

DROP POLICY IF EXISTS markets_audit_insert ON markets_audit;
CREATE POLICY markets_audit_insert
  ON markets_audit FOR INSERT WITH CHECK (markets_can_write());

-- review_queue: readable by viewer+, fully writable by manager+.
DROP POLICY IF EXISTS markets_review_queue_read ON markets_review_queue;
CREATE POLICY markets_review_queue_read
  ON markets_review_queue FOR SELECT USING (markets_can_read());

DROP POLICY IF EXISTS markets_review_queue_write ON markets_review_queue;
CREATE POLICY markets_review_queue_write
  ON markets_review_queue FOR ALL
  USING (markets_can_write()) WITH CHECK (markets_can_write());
