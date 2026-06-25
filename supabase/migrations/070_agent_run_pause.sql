-- 070_agent_run_pause.sql — Recoverable limit states for agent runs.
--
-- Applies the agent limit-handling playbook to NavHub's in-app agent runner:
-- recoverable errors (rate-limit retry exhaustion) land in a non-terminal
-- 'paused' state instead of 'error', and same-tool-same-input loops terminate
-- as 'stuck'. A legible pause_reason explains what was hit and what to do next.
--
-- agent_runs.status is a free-text column (no CHECK constraint — see
-- 007_agents.sql), so 'paused' and 'stuck' are accepted without an enum
-- migration. This migration only adds the pause_reason explanatory column.

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS pause_reason text;

COMMENT ON COLUMN agent_runs.pause_reason IS
  'Legible explanation when a run hits a limit / recoverable terminal '
  '(rate-limit exhaustion, iteration/token cap, stuck-loop). Surfaced as a '
  'distinct amber card on the run detail page, separate from error_message.';
