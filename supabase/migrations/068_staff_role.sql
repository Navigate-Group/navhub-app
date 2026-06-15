-- Migration 068: Staff role + invite-time permissions
-- ─────────────────────────────────────────────────────────────────────────
-- 1. Introduce a dedicated 'staff' role that sits between manager (rank 40)
--    and viewer (rank 20). Staff goes through the permission matrix (it is
--    NOT an admin-bypass role) with a fixed default set: Edit on Reports,
--    Documents and Agents; Financials and Marketing locked to 'No access'
--    ('Admin only') unless a group_owner / super_admin grants overrides.
--
-- 2. Add a `pending_permissions` JSONB column to group_invites so an admin
--    can stage permissions for a member BEFORE they accept. The rows are
--    seeded into user_permissions the moment the invite is claimed.
--
-- This file is idempotent — safe to re-run. All statements are guarded.

-- ── 1. Extend the user_role_enum with 'staff' (the column may have been
--      demoted to text in migration 062, so this is wrapped to survive
--      either shape).
DO $$ BEGIN
  ALTER TYPE user_role_enum ADD VALUE IF NOT EXISTS 'staff';
EXCEPTION WHEN others THEN NULL; END $$;

-- ── 2. Refresh the user_groups.role CHECK constraint to accept 'staff'.
--      Existing rows are unaffected (no value changes). role::text keeps
--      the comparison safe whether the column is text or the enum.
ALTER TABLE user_groups DROP CONSTRAINT IF EXISTS user_groups_role_check;
ALTER TABLE user_groups ADD CONSTRAINT user_groups_role_check
  CHECK (role::text = ANY (ARRAY[
    'super_admin',
    'group_owner',
    'group_admin',
    'manager',
    'staff',
    'viewer'
  ]));

-- ── 3. Stage pre-set permissions on the invite row. Shape mirrors the
--      PUT body of the permissions API:
--        [{ feature, company_id|null, access }]
--      Applied to user_permissions when the invite is claimed.
ALTER TABLE group_invites
  ADD COLUMN IF NOT EXISTS pending_permissions jsonb;
