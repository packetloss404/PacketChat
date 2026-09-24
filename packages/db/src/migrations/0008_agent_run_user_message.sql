-- Persist the user turn a run answers.
--
-- The assistant reply is parented under the run's user message, not under
-- whatever the conversation's active leaf happens to be when the answer is
-- written. For a synchronous run the route still holds that id in memory, but a
-- queued run is executed later by the worker, which never saw the request and
-- previously fell back to conversations.active_leaf_message_id. That fallback is
-- wrong whenever the conversation moved on - another turn was appended, or a
-- branch was switched - between the run being created and its answer landing, so
-- the final answer could nest under the wrong node.
--
-- The column is nullable, has no default and carries no foreign key, so this is
-- a catalog-only change: no table rewrite, no backfill and no validation scan of
-- messages, which is what makes it safe to apply to a live database with
-- existing rows. The missing foreign key is deliberate: a run should keep
-- reporting the turn it answered even after that message is deleted, and setting
-- it null on delete would silently re-introduce the wrong-parent fallback.
--
-- Rows created before this migration keep NULLs. The writer only falls back to
-- the active leaf for those legacy rows, which is the best available guess.

alter table agent_runs
  add column if not exists user_message_id uuid;
