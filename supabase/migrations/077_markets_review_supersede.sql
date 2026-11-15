-- Migration 077: Markets observation supersede columns (MKT-7b)
-- ──────────────────────────────────────────────────────────────────────────
-- The Review Queue (MKT-7b) promotes approved observations from
-- markets_review_queue into the live markets_observations fact table. When an
-- approved figure covers the same (geo, commodity, measure, season) as an
-- existing LIVE observation, that prior figure must be marked SUPERSEDED — kept
-- for history, excluded from live reads — while the new figure becomes live.
--
-- markets_observations already carries archived_at (migration 075) for manual
-- soft-delete. "Superseded" is a DISTINCT concept: the row was not archived by a
-- curator, it was replaced by a newer approved figure. Conflating the two would
-- lose that provenance, so this migration adds dedicated columns:
--
--   • superseded_at  — when the row was superseded (NULL = current)
--   • superseded_by  — the markets_review_queue entry id that replaced it
--
-- A partial index keeps "live, non-superseded" scans cheap (the common read).
--
-- Markets is a GLOBAL, role-gated corpus; no RLS change is needed — the existing
-- markets_observations policies (migration 072) already gate read to viewer+ and
-- write to manager+, and the promote path runs through the service-role client.
--
-- This file is idempotent — safe to re-run. All statements are guarded.

ALTER TABLE markets_observations
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS superseded_by uuid;

-- A current (live) observation is one that is neither archived nor superseded.
-- This partial index backs the live lookup the explorer + promote path run.
CREATE INDEX IF NOT EXISTS idx_markets_observations_current
  ON markets_observations (commodity, measure, season, geo)
  WHERE archived_at IS NULL AND superseded_at IS NULL;
