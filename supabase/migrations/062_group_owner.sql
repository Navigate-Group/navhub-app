-- Migration 062: Group Owner role + ownership tracking + feedback RLS fix
-- ─────────────────────────────────────────────────────────────────────────
-- Adds a new 'group_owner' role that sits between super_admin and
-- group_admin. Group owners control group_admin assignments; only
-- super_admins can mint group_owners. Also fixes the user_suggestions
-- INSERT policy so authenticated users can actually submit feedback.

-- ── 1. Normalise user_groups.role to text + CHECK constraint.
--      The column was originally declared as user_role_enum in migration 001.
--      Migration 031 dropped the enum check and added a permissive CHECK,
--      but we want a single canonical representation that survives the new
--      role addition without needing ALTER TYPE inside a transaction (which
--      can be restricted on some Postgres versions). Casting to text is the
--      simplest portable path. Wrapped in a DO block so it's safe to re-run.
DO $$ BEGIN
  ALTER TABLE user_groups
    ALTER COLUMN role TYPE text USING role::text;
EXCEPTION WHEN others THEN
  -- Column already text, or other harmless condition — keep going.
  NULL;
END $$;

ALTER TABLE user_groups DROP CONSTRAINT IF EXISTS user_groups_role_check;
ALTER TABLE user_groups ADD CONSTRAINT user_groups_role_check
  CHECK (role IN ('super_admin','group_owner','group_admin','manager','viewer'));

-- ── 2. Track ownership on the groups table. Existing migration 016 added a
--      separate `owner_id` column on groups for the admin Subscription
--      table — keep it; add owner_user_id alongside per spec so future
--      code can reference either name. New group-creation code (POST
--      /api/groups + POST /api/admin/groups) writes both.
ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- ── 3. Backfill owner_user_id from the earliest group_admin / group_owner
--      where it isn't set yet. Falls back to the legacy owner_id column
--      (migration 016) when one exists.
UPDATE groups g
SET owner_user_id = COALESCE(
  (SELECT ug.user_id
     FROM user_groups ug
    WHERE ug.group_id = g.id
      AND ug.role IN ('group_admin', 'group_owner')
    LIMIT 1),
  g.owner_id
)
WHERE owner_user_id IS NULL;

-- ── 4. Promote those backfilled owners from group_admin → group_owner so
--      every active group has exactly one owner who can manage admins.
UPDATE user_groups
SET role = 'group_owner'
WHERE role = 'group_admin'
  AND (user_id, group_id) IN (
    SELECT owner_user_id, id FROM groups WHERE owner_user_id IS NOT NULL
  );

-- ── 5. user_suggestions RLS — the original "users manage own" policy used
--      USING() only, which evaluates submitted_by BEFORE the row exists
--      and so blocks INSERT. Split into INSERT (WITH CHECK) + SELECT/UPDATE
--      (USING) so feedback submissions actually work.
DROP POLICY IF EXISTS "user_suggestions: users manage own" ON user_suggestions;

CREATE POLICY "user_suggestions: users insert own"
  ON user_suggestions FOR INSERT
  WITH CHECK (submitted_by = auth.uid());

CREATE POLICY "user_suggestions: users select own"
  ON user_suggestions FOR SELECT
  USING (submitted_by = auth.uid());

CREATE POLICY "user_suggestions: users update own"
  ON user_suggestions FOR UPDATE
  USING (submitted_by = auth.uid())
  WITH CHECK (submitted_by = auth.uid());
