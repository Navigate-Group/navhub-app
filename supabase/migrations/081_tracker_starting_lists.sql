-- Migration 081: Tracker agreed starting lists (completes the P1 corrections)
-- ──────────────────────────────────────────────────────────────────────────
-- 080 made tracker_init_group SECURITY DEFINER with a fixed search_path but
-- kept the starting lookup values 079 seeded. This migration replaces them
-- with the agreed starting lists (data model section 5), which match the keys
-- the import translates the existing tracker's values into.
--
--   1. tracker_init_group seeds exactly the agreed lists (region starts empty);
--      still SECURITY DEFINER with SET search_path = public, pg_temp.
--   2. 079's starting values that are not in the agreed lists are deleted.
--   3. Keys shared by 079 and the agreed lists get the agreed label and
--      display order.
--   4. Every group already initialised is re-seeded with the agreed lists.
--
-- Only tracker_* objects are touched. Safe to re-run.

-- ── 1. tracker_init_group: the agreed starting lists ────────────────────────
CREATE OR REPLACE FUNCTION tracker_init_group(p_group_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO tracker_settings (group_id)
  VALUES (p_group_id)
  ON CONFLICT (group_id) DO NOTHING;

  INSERT INTO tracker_lookups (group_id, list, key, label, sort_order)
  VALUES
    (p_group_id, 'category', 'product_software',      'Product & software',      0),
    (p_group_id, 'category', 'data_science_ci',       'Data science & CI',       1),
    (p_group_id, 'category', 'partners_field_trials', 'Partners & field trials', 2),
    (p_group_id, 'category', 'proposals_pipeline',    'Proposals & pipeline',    3),
    (p_group_id, 'category', 'grants',                'Grants',                  4),
    (p_group_id, 'status', 'on_track',              'On track',                0),
    (p_group_id, 'status', 'at_risk',               'At risk',                 1),
    (p_group_id, 'status', 'blocked',               'Blocked',                 2),
    (p_group_id, 'status', 'waiting_on_others',     'Waiting on others',       3),
    (p_group_id, 'status', 'proposal_pre_contract', 'Proposal / pre-contract', 4),
    (p_group_id, 'status', 'wrapping_up',           'Wrapping up',             5),
    (p_group_id, 'status', 'needs_status_check',    'Needs a status check',    6),
    (p_group_id, 'status', 'finished',              'Finished',                7),
    (p_group_id, 'milestone_status', 'backlog',     'Backlog',     0),
    (p_group_id, 'milestone_status', 'planned',     'Planned',     1),
    (p_group_id, 'milestone_status', 'in_progress', 'In progress', 2),
    (p_group_id, 'milestone_status', 'at_risk',     'At risk',     3),
    (p_group_id, 'milestone_status', 'blocked',     'Blocked',     4),
    (p_group_id, 'milestone_status', 'completed',   'Completed',   5),
    (p_group_id, 'milestone_status', 'cancelled',   'Cancelled',   6),
    (p_group_id, 'action_type', 'do',      'Do',      0),
    (p_group_id, 'action_type', 'call',    'Call',    1),
    (p_group_id, 'action_type', 'email',   'Email',   2),
    (p_group_id, 'action_type', 'chase',   'Chase',   3),
    (p_group_id, 'action_type', 'decide',  'Decide',  4),
    (p_group_id, 'action_type', 'meeting', 'Meeting', 5),
    (p_group_id, 'source', 'my_note',     'My note',       0),
    (p_group_id, 'source', 'email',       'Email',         1),
    (p_group_id, 'source', 'screenshot',  'Screenshot',    2),
    (p_group_id, 'source', 'meeting',     'Meeting',       3),
    (p_group_id, 'source', 'file_folder', 'File / folder', 4),
    (p_group_id, 'source', 'call',        'Call',          5),
    (p_group_id, 'review_step', 'clear_inbox',           'Clear inbox',               0),
    (p_group_id, 'review_step', 'next_action_each_plan', 'Next action for each plan', 1),
    (p_group_id, 'review_step', 'chase_waiting',         'Chase waiting',             2),
    (p_group_id, 'review_step', 'refresh_status',        'Refresh status',            3),
    (p_group_id, 'review_step', 'look_ahead',            'Look ahead',                4),
    (p_group_id, 'review_step', 'book_calls',            'Book calls',                5),
    (p_group_id, 'review_step', 'pick_top_three',        'Pick top three',            6)
    -- region: starts empty
  ON CONFLICT (group_id, list, key) DO NOTHING;
END;
$$;

-- ── 2. Remove 079's starting values that are not in the agreed lists ───────
-- Exact 079 keys only.
DELETE FROM tracker_lookups
WHERE (list, key) IN (
  ('category','project'), ('category','program'), ('category','bau'),
  ('status','planned'), ('status','active'), ('status','on_hold'),
  ('status','complete'), ('status','cancelled'),
  ('milestone_status','done'),
  ('action_type','task'), ('action_type','follow_up'),
  ('source','manual'), ('source','import'),
  ('review_step','overdue'), ('review_step','due_soon'), ('review_step','stale'),
  ('review_step','contacts'), ('review_step','top3'),
  ('region','wa'), ('region','nsw'), ('region','vic'), ('region','qld'),
  ('region','sa'), ('region','tas'), ('region','nt'), ('region','act')
);

-- ── 3. Shared keys: agreed label and display order ──────────────────────────
-- Only rows still carrying 079's exact value are touched, so a re-run never
-- overrides a later change by a Manager.
UPDATE tracker_lookups SET label = 'In progress'
WHERE list = 'milestone_status' AND key = 'in_progress' AND label = 'In Progress';

UPDATE tracker_lookups SET sort_order = 5
WHERE list = 'action_type' AND key = 'meeting' AND sort_order = 3;

UPDATE tracker_lookups SET sort_order = 2
WHERE list = 'milestone_status' AND key = 'in_progress' AND sort_order = 1;

UPDATE tracker_lookups SET sort_order = 4
WHERE list = 'milestone_status' AND key = 'blocked' AND sort_order = 2;

UPDATE tracker_lookups SET sort_order = 3
WHERE list = 'source' AND key = 'meeting' AND sort_order = 2;

-- ── 4. Re-seed every group already initialised ──────────────────────────────
SELECT tracker_init_group(group_id) FROM tracker_settings;
