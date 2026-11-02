-- Migration 071: Markets access & role-gating (MKT-1)
-- ──────────────────────────────────────────────────────────────────────────
-- Establishes Markets as a role-gated area. Markets roles are INDEPENDENT of
-- the per-group `user_groups` roles — a user holds a Markets role globally,
-- not scoped to a NavHub group. Two roles exist:
--
--   markets_viewer  → can reach the Markets explorer (/markets)
--   markets_manager → can additionally reach curation surfaces (/markets/manage/*)
--
-- A platform super admin (user_groups.role = 'super_admin') is ALWAYS treated
-- as a Markets super admin in application code — they bypass this table and
-- are the only principals allowed to grant / revoke rows here.
--
-- This file is idempotent — safe to re-run. All statements are guarded.

-- ── 1. market_user_roles ───────────────────────────────────────────────────
-- A grant is "active" when revoked_at IS NULL. Revoking sets revoked_at rather
-- than deleting so the history of who granted / revoked what is preserved.
CREATE TABLE IF NOT EXISTS market_user_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('markets_viewer', 'markets_manager')),
  granted_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  -- One active grant row per (user, role). A user may legitimately be promoted
  -- from viewer → manager, holding both rows; application code treats the
  -- highest active role as effective.
  UNIQUE (user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_market_user_roles_user
  ON market_user_roles (user_id) WHERE revoked_at IS NULL;

ALTER TABLE market_user_roles ENABLE ROW LEVEL SECURITY;

-- ── 2. RLS ──────────────────────────────────────────────────────────────────
-- Readable by the role holder (so a Markets user can confirm their own access)
-- AND by super admins. Writable by super admins only. Server routes use the
-- service-role admin client and bypass RLS entirely; these policies protect the
-- anon/authenticated paths.

DROP POLICY IF EXISTS "market_user_roles: holder or super admin reads" ON market_user_roles;
CREATE POLICY "market_user_roles: holder or super admin reads"
  ON market_user_roles FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM user_groups
      WHERE user_id = auth.uid() AND role = 'super_admin'
    )
  );

DROP POLICY IF EXISTS "market_user_roles: super admin writes" ON market_user_roles;
CREATE POLICY "market_user_roles: super admin writes"
  ON market_user_roles FOR ALL
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
