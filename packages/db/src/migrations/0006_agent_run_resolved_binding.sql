-- Persist the provider account and model a run was resolved against.
--
-- The run row already pins agent_version_id, so the agent's spec is
-- reproducible, but the provider account and model are resolved per request. A
-- queue worker that re-resolved them could execute the run against a different
-- model than the caller was promised, silently, for example after the default
-- provider account changed between enqueue and execution. Persisting the
-- resolved pair makes the executed binding a fact of the run rather than
-- something reconstructed later, and it survives a dropped job.
--
-- Both columns are nullable, have no default and carry no foreign key, so this
-- is a catalog-only change: no table rewrite, no backfill and no validation
-- scan of provider_accounts, which is what makes it safe to apply to a live
-- database with existing rows. The missing foreign key is deliberate twice
-- over: it keeps the lock footprint to agent_runs alone, and a run should keep
-- reporting which account it used even after that account is deleted.
--
-- Rows created before this migration keep NULLs, which is correct: nobody
-- recorded what they ran, and the worker refuses a run whose binding is
-- unknown rather than guessing at one.

alter table agent_runs
  add column if not exists resolved_provider_account_id uuid;

alter table agent_runs
  add column if not exists resolved_model text;
