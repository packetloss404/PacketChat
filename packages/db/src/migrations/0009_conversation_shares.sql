-- Conversation share links: a revocable, read-only public view of a
-- conversation's active path.
--
-- A share is deliberately a separate row rather than a flag on conversations so
-- that links are individually revocable, auditable and cascade with both the
-- conversation and its owner. `token` is the bearer secret in the public URL;
-- it is high-entropy and unique so it cannot be guessed or reused. Revocation
-- is a timestamp rather than a delete so that a revoked link stays visible to
-- its owner (and in future audits) without being resolvable.
--
-- `active_leaf_message_id` snapshots the conversation's active branch leaf at
-- creation so the public transcript is built from a stable path. It is
-- nullable and carries no foreign key, matching conversations.active_leaf_message_id
-- (0007): a message deleted later must not cascade the share away, and the
-- public read fails closed (404) if the recorded leaf no longer exists rather
-- than drifting onto newer content.
--
-- The partial unique index allows any number of revoked links but at most one
-- live link per conversation, so `POST` is idempotent under a race.

create table if not exists conversation_shares (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  token text not null unique,
  active_leaf_message_id uuid,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists conversation_shares_conversation_id_idx
  on conversation_shares(conversation_id);

create index if not exists conversation_shares_owner_user_id_idx
  on conversation_shares(owner_user_id);

create unique index if not exists conversation_shares_active_conversation_idx
  on conversation_shares(conversation_id)
  where revoked_at is null;
