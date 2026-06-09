-- 067_superadmin_provider_configs.sql — Superadmin-managed platform-wide default provider API keys

-- Platform-wide default provider API keys (group_id IS NULL = superadmin-managed)
-- These serve as fallback for admin-scoped Sage and Assistant when no group config exists.
-- Group agents always require explicit group-level provider configuration.
CREATE TABLE IF NOT EXISTS superadmin_provider_configs (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text        NOT NULL CHECK (provider IN ('anthropic','openai','google','mistral','custom')) UNIQUE,
  api_key_encrypted text        NOT NULL,
  base_url          text,                          -- for custom OpenAI-compatible providers
  is_active         boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- No RLS needed — superadmin routes use admin client and check role in code
-- The table is superadmin-only; no user-level access

-- Index for active lookups
CREATE INDEX IF NOT EXISTS idx_superadmin_provider_configs_active ON superadmin_provider_configs(provider, is_active);
