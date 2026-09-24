-- PacketAgent integration: a project can connect a PacketAgent deployment, start
-- a worker run, and receive versioned Worker notifications that PacketChat
-- renders as a threaded run card.
--
-- Three additive tables, all owned by the PacketChat user that created the
-- connection and cascading with the project and that user:
--
-- - packet_agent_connections: the configured link from a project to one
--   PacketAgent workspace. `agent_credentials` holds the outbound agent bearer
--   token encrypted at rest (never returned to clients). The inbound
--   notification token is not stored: only its digest and a short display
--   prefix, so a database read cannot replay the ingest credential.
-- - packet_agent_runs: one row per PacketAgent worker run, keyed by
--   (connection_id, worker_run_id). `callbacks` holds the signed open/inspect
--   URLs encrypted at rest; they are proxied server-side and never exposed to
--   the browser.
-- - packet_agent_run_events: the append-only notification thread. The
--   (connection_id, message_key) unique index makes a redelivered notification
--   idempotent: a duplicate message key can never create a second event.

create table if not exists packet_agent_connections (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  name text not null,
  workspace_id text not null,
  deployment_id text,
  agent_base_url text not null,
  agent_credentials jsonb not null,
  ingest_token_digest text not null,
  ingest_token_prefix text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  rotated_at timestamptz
);

create unique index if not exists packet_agent_connections_project_workspace_idx
  on packet_agent_connections(project_id, workspace_id);

create index if not exists packet_agent_connections_project_id_idx
  on packet_agent_connections(project_id);

create index if not exists packet_agent_connections_owner_user_id_idx
  on packet_agent_connections(owner_user_id);

create table if not exists packet_agent_runs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references packet_agent_connections(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  workspace_id text not null,
  thread_key text not null,
  worker_run_id text not null,
  worker_definition_id text not null,
  worker_deployment_id text not null,
  worker_version_id text not null,
  worker_version_content_digest text not null,
  title text not null,
  summary text not null,
  state jsonb not null,
  budget jsonb not null,
  checkpoint jsonb,
  required_action text not null default 'none',
  evidence jsonb not null default '{}'::jsonb,
  callbacks jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists packet_agent_runs_connection_run_idx
  on packet_agent_runs(connection_id, worker_run_id);

create index if not exists packet_agent_runs_project_id_idx
  on packet_agent_runs(project_id);

create index if not exists packet_agent_runs_owner_user_id_idx
  on packet_agent_runs(owner_user_id);

create index if not exists packet_agent_runs_connection_id_idx
  on packet_agent_runs(connection_id);

create table if not exists packet_agent_run_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references packet_agent_runs(id) on delete cascade,
  connection_id uuid not null references packet_agent_connections(id) on delete cascade,
  message_key text not null,
  idempotency_key text not null,
  event text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create unique index if not exists packet_agent_run_events_connection_message_idx
  on packet_agent_run_events(connection_id, message_key);

create index if not exists packet_agent_run_events_run_id_idx
  on packet_agent_run_events(run_id);

create index if not exists packet_agent_run_events_connection_id_idx
  on packet_agent_run_events(connection_id);
