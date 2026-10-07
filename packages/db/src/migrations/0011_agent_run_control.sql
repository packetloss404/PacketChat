-- Cross-process control and liveness for durable agent runs.
--
-- cancel_requested_at is durable intent: an executor in another process sees it
-- on its next heartbeat and aborts its provider request. heartbeat_at and
-- lease_expires_at distinguish a live executor from a run that merely started
-- a long time ago, so recovery no longer guesses from created_at/started_at.
alter table agent_runs
  add column if not exists cancel_requested_at timestamptz;

alter table agent_runs
  add column if not exists heartbeat_at timestamptz;

alter table agent_runs
  add column if not exists lease_expires_at timestamptz;

create index if not exists agent_runs_expired_lease_idx
  on agent_runs(lease_expires_at)
  where status in ('preparing', 'running');
