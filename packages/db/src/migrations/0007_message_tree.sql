-- Conversation message tree: persist the active branch leaf and index the
-- parent link so clients can reconstruct the active path.
--
-- messages.parent_message_id already exists (0001) with `on delete set null`;
-- this migration only adds the column that records which leaf the active branch
-- currently ends at, plus supporting indexes.
--
-- The column is nullable, has no default and carries no foreign key, so this is
-- a catalog-only change on Postgres 11+: no table rewrite, no backfill and no
-- validation scan of messages, which is what makes it safe to apply to a live
-- database with existing rows. The missing foreign key is deliberate: messages
-- already cascade-delete with their conversation, and an FK from conversations
-- to messages would introduce a circular dependency while adding no integrity
-- we rely on. A leaf that points at a message removed outside that path simply
-- reads as "no active leaf", which the read path tolerates.

alter table conversations
  add column if not exists active_leaf_message_id uuid;

create index if not exists conversations_active_leaf_message_id_idx
  on conversations(active_leaf_message_id);

create index if not exists messages_parent_message_id_idx
  on messages(parent_message_id);
