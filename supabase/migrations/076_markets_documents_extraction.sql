-- Migration 076: Markets document upload & extraction (MKT-7a)
-- ──────────────────────────────────────────────────────────────────────────
-- Builds the ingest side of Markets: Managers upload source documents (PDF,
-- XLSX, CSV, PNG, JPEG) into the existing private `markets-documents` bucket;
-- a Document Extractor turns them into PENDING observations / structure records
-- for review in a later phase (MKT-7b). This phase adds:
--
--   1. New metadata + lifecycle columns on markets_documents (the schema stub
--      from migration 072). The status CHECK is widened to the MKT-7a lifecycle
--      (pending_extraction → extracting → extracted | extraction_failed) while
--      keeping the original 072 values valid so existing rows stay legal.
--
--   2. markets_document_chunks — the extraction work queue. One row per unit of
--      work: whole-document for spreadsheets/images/small PDFs, or a 20-page
--      range for a large PDF. A dedicated cron (process-markets-extractions)
--      claims queued chunks race-safely and runs each inside its own ≤300 s
--      lambda — mirroring the agents process-queued-runs design, but kept
--      separate because Markets is a GLOBAL (not group-scoped) area and the
--      agents queue is hard-wired to the agents / groups tables.
--
--   3. markets_structure_queue — pending farm-structure records extracted from
--      documents, awaiting a Manager's approval (MKT-7b). Mirrors the shape of
--      markets_review_queue (migration 075) which already stages pending
--      OBSERVATIONS; structure is staged here because its row shape differs.
--
--   4. markets_agent_runs — the Document Extractor run log. The brief asked to
--      log to `agent_runs`, but that table (migration 007) is NOT NULL-bound to
--      agent_id + group_id, is group-scoped via RLS, and lacks every column the
--      brief enumerates (user_id, input, output, duration_ms, type, tags).
--      Markets is a global, role-gated corpus (like markets_audit /
--      markets_review_queue), so a dedicated markets_agent_runs table carries
--      exactly the brief's columns without distorting the shared agents table.
--
-- Markets is a GLOBAL area — every table here is a single shared corpus gated
-- purely by the Markets role via the markets_can_read()/markets_can_write()
-- helpers from migration 072. Service-role routes (upload handler + extraction
-- cron) bypass RLS and own the privileged writes.
--
-- This file is idempotent — safe to re-run. All statements are guarded.

-- ── 1. Extend markets_documents ────────────────────────────────────────────
-- Metadata captured at upload (commodity/geography hints, season, source,
-- notes) plus the MKT-7a lifecycle. The original 072 columns (title,
-- storage_path, mime_type, size_bytes, uploaded_by, status, archived_at)
-- already exist; we add the rest and widen the status CHECK.

ALTER TABLE markets_documents
  ADD COLUMN IF NOT EXISTS original_filename text,
  ADD COLUMN IF NOT EXISTS commodities      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- commodity id hints
  ADD COLUMN IF NOT EXISTS geographies      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- geo id hints
  ADD COLUMN IF NOT EXISTS season           text,
  ADD COLUMN IF NOT EXISTS source_id        text REFERENCES markets_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notes            text,
  ADD COLUMN IF NOT EXISTS page_count       integer,
  ADD COLUMN IF NOT EXISTS extraction_error text;

-- Widen the status CHECK to cover the MKT-7a lifecycle. The original 072 values
-- (uploaded / processing / extracted / error) stay valid so existing rows and
-- older code paths remain legal; the new values are the ones MKT-7a writes.
ALTER TABLE markets_documents DROP CONSTRAINT IF EXISTS markets_documents_status_check;
ALTER TABLE markets_documents
  ADD CONSTRAINT markets_documents_status_check CHECK (status IN (
    'uploaded', 'processing', 'extracted', 'error',          -- legacy (072)
    'pending_extraction', 'extracting', 'extraction_failed'  -- MKT-7a
  ));

-- New uploads default to 'pending_extraction'. (ALTER DEFAULT is idempotent.)
ALTER TABLE markets_documents ALTER COLUMN status SET DEFAULT 'pending_extraction';

CREATE INDEX IF NOT EXISTS idx_markets_documents_status
  ON markets_documents (status) WHERE archived_at IS NULL;

-- ── 2. markets_document_chunks ─────────────────────────────────────────────
-- The extraction work queue. One row per unit of extraction work:
--   • spreadsheet / image / small PDF  → a single chunk (page_start/end NULL)
--   • large PDF (> 20 pages)           → one chunk per 20-page range
-- A dedicated cron claims queued chunks race-safely (status queued → running
-- gated on `.eq('status','queued')`) and runs each in its own ≤300 s lambda.
CREATE TABLE IF NOT EXISTS markets_document_chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES markets_documents(id) ON DELETE CASCADE,
  page_start    integer,                               -- 1-based, inclusive; NULL = whole document
  page_end      integer,                               -- inclusive
  status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'done', 'error')),
  attempts      integer NOT NULL DEFAULT 0,
  error_message text,
  run_id        uuid,                                  -- FK to markets_agent_runs (added below)
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  completed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_markets_document_chunks_status
  ON markets_document_chunks (status, created_at);
CREATE INDEX IF NOT EXISTS idx_markets_document_chunks_document
  ON markets_document_chunks (document_id);

-- ── 3. markets_structure_queue ─────────────────────────────────────────────
-- Pending farm-structure records extracted from documents, awaiting a
-- Manager's approval (MKT-7b). `payload` holds the proposed markets_structure
-- row shape (area size / turnover / ownership / breakdowns) as JSONB.
CREATE TABLE IF NOT EXISTS markets_structure_queue (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payload       jsonb NOT NULL,                        -- proposed markets_structure row
  commodity     text,                                  -- denormalised for queue filtering
  geo           text,                                  -- denormalised geo id
  document_id   uuid REFERENCES markets_documents(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  review_note   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_markets_structure_queue_status
  ON markets_structure_queue (status);
CREATE INDEX IF NOT EXISTS idx_markets_structure_queue_commodity
  ON markets_structure_queue (commodity);

-- ── 4. markets_agent_runs ──────────────────────────────────────────────────
-- The Document Extractor run log. Carries exactly the columns the brief
-- enumerates. `type` identifies the agent kind ('document_extractor'); `tags`
-- is a free JSONB array (['Markets']); `input` / `output` are JSONB (document
-- id + chunk range + hints in; counts out). Operator mentions and any other
-- pending-only data the POC captures are stored verbatim under output so they
-- survive for later use without a dedicated UI.
CREATE TABLE IF NOT EXISTS markets_agent_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,  -- uploader / trigger
  type          text NOT NULL DEFAULT 'document_extractor',
  status        text NOT NULL DEFAULT 'success'
                  CHECK (status IN ('success', 'partial', 'error')),
  input         jsonb NOT NULL DEFAULT '{}'::jsonb,    -- { document_id, page_start, page_end, hints }
  output        jsonb NOT NULL DEFAULT '{}'::jsonb,    -- { observations, structure, operators, unmatched, … }
  tokens_used   integer,
  duration_ms   integer,
  tags          jsonb NOT NULL DEFAULT '[]'::jsonb,    -- ['Markets']
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_markets_agent_runs_type    ON markets_agent_runs (type);
CREATE INDEX IF NOT EXISTS idx_markets_agent_runs_user    ON markets_agent_runs (user_id);
CREATE INDEX IF NOT EXISTS idx_markets_agent_runs_created ON markets_agent_runs (created_at);

-- Now that markets_agent_runs exists, point chunks.run_id at it.
ALTER TABLE markets_document_chunks
  DROP CONSTRAINT IF EXISTS fk_markets_document_chunks_run;
ALTER TABLE markets_document_chunks
  ADD CONSTRAINT fk_markets_document_chunks_run
  FOREIGN KEY (run_id) REFERENCES markets_agent_runs(id) ON DELETE SET NULL;

-- ── 5. Row-level security ──────────────────────────────────────────────────
-- Uniform Markets policy: read-gate to viewer+ (markets_can_read()), write-gate
-- to manager+ (markets_can_write()). Service-role routes bypass RLS entirely.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'markets_document_chunks',
    'markets_structure_queue',
    'markets_agent_runs'
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
