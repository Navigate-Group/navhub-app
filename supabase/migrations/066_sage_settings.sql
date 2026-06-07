-- Migration 066: Sage Phase 1 — In-app connection settings
--
-- Creates sage_settings table to store Builder URL, shared secret, and app slug
-- in the database instead of env vars. Enables operators to configure the
-- Kaizen contract connection via the UI without deployments.

CREATE TABLE IF NOT EXISTS sage_settings (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_url     text        NOT NULL,
  shared_secret   text        NOT NULL,
  app_slug        text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Only one row should exist (singleton pattern)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sage_settings_singleton ON sage_settings ((true));

ALTER TABLE sage_settings ENABLE ROW LEVEL SECURITY;

-- Super admin only access
CREATE POLICY "sage_settings: super admin only"
  ON sage_settings FOR ALL
  USING (EXISTS (
    SELECT 1 FROM user_groups
    WHERE user_id = auth.uid() AND role = 'super_admin'
  ));

COMMENT ON TABLE sage_settings IS 'Sage contract connection config (Builder URL, shared secret, app slug)';
