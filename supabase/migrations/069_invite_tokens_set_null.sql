-- 069_invite_tokens_set_null.sql — Keep invite_tokens rows queryable after
-- the originating group_invites row is deleted.
--
-- Problem: invite_tokens.invite_id was created (migration 061) with
-- ON DELETE CASCADE. When an admin cancels or resends an invite, the
-- group_invites row is deleted and the matching invite_tokens row vanishes
-- with it. But the email the user already received still points at
-- /invite/<token>. The landing page then can't find the token and renders a
-- bare 404 with no explanation or path forward.
--
-- Fix: switch the FK to ON DELETE SET NULL so the token row survives. The
-- row stays queryable (email, group_name, role, used_at, expires_at) which
-- lets the landing page render a graceful "this link is no longer valid"
-- state with contextual next steps instead of a 404. invite_id simply
-- becomes NULL once the parent invite is gone.

ALTER TABLE invite_tokens
  DROP CONSTRAINT IF EXISTS invite_tokens_invite_id_fkey;

ALTER TABLE invite_tokens
  ADD CONSTRAINT invite_tokens_invite_id_fkey
  FOREIGN KEY (invite_id) REFERENCES group_invites(id) ON DELETE SET NULL;
