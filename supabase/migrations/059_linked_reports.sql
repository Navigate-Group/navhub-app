-- 059_linked_reports.sql — linked reports on a run, mirroring linked_document_ids.
--
-- The runner materialises each linked report into agent_run_attachments at
-- run start (HTML stripped to plain text, clamped to 50k chars) so the
-- agent can call read_attachment with the report's name without needing a
-- separate "read_report" tool.

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS linked_report_ids uuid[] NOT NULL DEFAULT '{}';
