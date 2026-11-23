-- Migration 085: Tracker milestone and action dates (P6)
-- ──────────────────────────────────────────────────────────────────────────
-- Keeps the dates the screens and views rely on in step with status changes,
-- so nobody has to fill them in by hand:
--
--   Actions     status → done     sets done_on to today (if not given)
--               status → waiting  sets waiting_since to today (if not given)
--               leaving done      clears done_on
--               leaving waiting   clears waiting_since
--   Milestones  new milestone     baseline_due_on = due_on (if not given)
--               status → completed sets completed_on to today (if not given)
--               leaving completed  clears completed_on
--
-- "Today" is the group's today (tracker_today, migration 083). Dates passed in
-- explicitly (for example by the import, migration 084) are kept.
--
-- It also guards the baseline: only the milestone's owner or a Manager / Group
-- Owner may change baseline_due_on (the original due date "days slipped" is
-- measured against). Anyone else with edit access can still move due_on.
-- Like the other guards (082), it only applies to signed-in requests.
--
-- Requires migrations 079–084. Only tracker_* objects are touched. Safe to re-run.

-- ── 1. Actions: done_on and waiting_since follow the status ────────────────
CREATE OR REPLACE FUNCTION tracker_action_dates()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_status tracker_action_status := CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END;
BEGIN
  IF NEW.status = 'done' THEN
    IF NEW.done_on IS NULL THEN
      NEW.done_on := tracker_today(NEW.group_id);
    END IF;
  ELSIF v_old_status = 'done' THEN
    NEW.done_on := NULL;
  END IF;

  IF NEW.status = 'waiting' THEN
    IF NEW.waiting_since IS NULL THEN
      NEW.waiting_since := tracker_today(NEW.group_id);
    END IF;
  ELSIF v_old_status = 'waiting' THEN
    NEW.waiting_since := NULL;
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tracker_action_dates ON tracker_actions;
CREATE TRIGGER trg_tracker_action_dates
  BEFORE INSERT OR UPDATE OF status, done_on, waiting_since ON tracker_actions
  FOR EACH ROW EXECUTE FUNCTION tracker_action_dates();

-- ── 2. Milestones: baseline and completed_on ────────────────────────────────
CREATE OR REPLACE FUNCTION tracker_milestone_dates()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.baseline_due_on IS NULL THEN
    NEW.baseline_due_on := NEW.due_on;
  END IF;

  IF NEW.status = 'completed' THEN
    IF NEW.completed_on IS NULL THEN
      NEW.completed_on := tracker_today(NEW.group_id);
    END IF;
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'completed' THEN
    NEW.completed_on := NULL;
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tracker_milestone_dates ON tracker_milestones;
CREATE TRIGGER trg_tracker_milestone_dates
  BEFORE INSERT OR UPDATE ON tracker_milestones
  FOR EACH ROW EXECUTE FUNCTION tracker_milestone_dates();

-- ── 3. Only the milestone's owner or an editor may change the baseline ──────
CREATE OR REPLACE FUNCTION tracker_milestone_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.baseline_due_on IS DISTINCT FROM OLD.baseline_due_on
     AND NOT tracker_is_editor(NEW.group_id)
     AND OLD.owner_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Only the milestone''s owner or a Manager can change its original due date'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tracker_milestone_guard ON tracker_milestones;
CREATE TRIGGER trg_tracker_milestone_guard
  BEFORE UPDATE ON tracker_milestones
  FOR EACH ROW EXECUTE FUNCTION tracker_milestone_guard();
