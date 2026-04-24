create extension if not exists pgcrypto;

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null,
  role text not null default 'user' check (role in ('admin', 'user')),
  status text not null default 'active' check (status in ('active', 'disabled', 'locked', 'invited')),
  is_break_glass boolean not null default false,
  byok_enabled boolean not null default false,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table password_credentials (
  user_id uuid primary key references users(id) on delete cascade,
  password_hash text not null,
  force_reset boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  auth_method text not null default 'local' check (auth_method in ('local', 'break_glass')),
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text
);

create index sessions_user_id_idx on sessions(user_id);

create table refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  family_id uuid not null,
  token_hash text not null unique,
  parent_token_id uuid references refresh_tokens(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  reuse_detected_at timestamptz
);

create index refresh_tokens_session_id_idx on refresh_tokens(session_id);
create index refresh_tokens_family_id_idx on refresh_tokens(family_id);

create table invite_tokens (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  role text not null default 'user' check (role in ('admin', 'user')),
  token_hash text not null unique,
  created_by uuid references users(id) on delete set null,
  consumed_by uuid references users(id) on delete set null,
  consumed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  created_by uuid references users(id) on delete set null,
  consumed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references users(id) on delete set null,
  action text not null,
  outcome text not null default 'success' check (outcome in ('success', 'failure')),
  target_type text,
  target_id text,
  ip_address text,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_events_actor_user_id_idx on audit_events(actor_user_id);
create index audit_events_action_idx on audit_events(action);
create index audit_events_created_at_idx on audit_events(created_at desc);

create table provider_accounts (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('openai-compatible', 'azure-openai', 'anthropic', 'perplexity', 'minimax')),
  scope text not null default 'global' check (scope in ('global', 'user')),
  owner_user_id uuid references users(id) on delete cascade,
  display_name text not null,
  base_url text,
  api_version text,
  region text,
  status text not null default 'enabled' check (status in ('enabled', 'disabled')),
  is_default boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_accounts_scope_owner_check check (
    (scope = 'global' and owner_user_id is null) or (scope = 'user' and owner_user_id is not null)
  )
);

create index provider_accounts_provider_idx on provider_accounts(provider);
create index provider_accounts_owner_user_id_idx on provider_accounts(owner_user_id);

create table provider_credentials (
  id uuid primary key default gen_random_uuid(),
  provider_account_id uuid not null references provider_accounts(id) on delete cascade,
  secret_kind text not null default 'api_key',
  encrypted_payload jsonb not null,
  key_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table model_catalog (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('openai-compatible', 'azure-openai', 'anthropic', 'perplexity', 'minimax')),
  vendor_model_id text not null,
  display_name text not null,
  family text,
  lifecycle text not null default 'ga' check (lifecycle in ('ga', 'preview', 'deprecated')),
  capabilities jsonb not null default '{}'::jsonb,
  raw_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, vendor_model_id)
);

create table model_account_bindings (
  id uuid primary key default gen_random_uuid(),
  provider_account_id uuid not null references provider_accounts(id) on delete cascade,
  model_catalog_id uuid references model_catalog(id) on delete set null,
  provider_model_ref jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  capability_overrides jsonb not null default '{}'::jsonb,
  pricing jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table model_presets (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references users(id) on delete cascade,
  provider_account_id uuid not null references provider_accounts(id) on delete cascade,
  model_account_binding_id uuid references model_account_bindings(id) on delete set null,
  name text not null,
  provider text not null,
  model text not null,
  parameters jsonb not null default '{}'::jsonb,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  name text not null,
  description text,
  instructions text,
  default_model_preset_id uuid references model_presets(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index projects_owner_user_id_idx on projects(owner_user_id);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  title text not null default 'New chat',
  mode text not null default 'chat' check (mode in ('chat', 'agent_test')),
  temporary boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversations_owner_user_id_idx on conversations(owner_user_id);
create index conversations_project_id_idx on conversations(project_id);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('system', 'developer', 'user', 'assistant', 'tool')),
  content jsonb not null,
  metadata jsonb not null default '{}'::jsonb,
  parent_message_id uuid references messages(id) on delete set null,
  created_at timestamptz not null default now()
);

create index messages_conversation_id_idx on messages(conversation_id);
create index messages_owner_user_id_idx on messages(owner_user_id);

create table conversation_runs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  provider_account_id uuid references provider_accounts(id) on delete set null,
  model text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  request jsonb not null default '{}'::jsonb,
  response jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  ended_at timestamptz,
  error_message text,
  created_at timestamptz not null default now()
);

create table attachments (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete cascade,
  message_id uuid references messages(id) on delete set null,
  bucket text not null,
  object_key text not null,
  file_name text not null,
  mime_type text,
  size_bytes bigint not null default 0,
  status text not null default 'uploaded' check (status in ('uploaded', 'processing', 'ready', 'failed')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table prompt_templates (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  name text not null,
  description text,
  body text not null,
  variables jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table prompt_versions (
  id uuid primary key default gen_random_uuid(),
  prompt_template_id uuid not null references prompt_templates(id) on delete cascade,
  version_number integer not null,
  body text not null,
  variables jsonb not null default '[]'::jsonb,
  change_summary text,
  created_at timestamptz not null default now(),
  unique (prompt_template_id, version_number)
);

create table knowledge_bases (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'active' check (status in ('active', 'archived')),
  retrieval_defaults jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null references knowledge_bases(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  attachment_id uuid references attachments(id) on delete set null,
  title text not null,
  mime_type text,
  ingest_status text not null default 'queued' check (ingest_status in ('queued', 'processing', 'ready', 'failed')),
  source_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references knowledge_documents(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  token_count integer,
  embedding jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create table retrieval_runs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  knowledge_base_id uuid references knowledge_bases(id) on delete set null,
  query text not null,
  results jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table tools (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references users(id) on delete cascade,
  key text not null,
  name text not null,
  description text,
  tool_type text not null default 'builtin' check (tool_type in ('builtin', 'http', 'mcp', 'workflow')),
  status text not null default 'enabled' check (status in ('enabled', 'disabled')),
  config_schema jsonb not null default '{}'::jsonb,
  auth_scheme text not null default 'none',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, key)
);

create table tool_versions (
  id uuid primary key default gen_random_uuid(),
  tool_id uuid not null references tools(id) on delete cascade,
  version_number integer not null,
  contract jsonb not null default '{}'::jsonb,
  runtime_config jsonb not null default '{}'::jsonb,
  content_hash text not null,
  published_at timestamptz not null default now(),
  unique (tool_id, version_number)
);

create table agents (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  current_draft_id uuid,
  published_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table agent_drafts (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  base_version_id uuid,
  spec jsonb not null default '{}'::jsonb,
  editor_state jsonb not null default '{}'::jsonb,
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);

create table agent_versions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  version_number integer not null,
  spec jsonb not null,
  manifest jsonb not null,
  content_hash text not null,
  change_summary text,
  published_at timestamptz not null default now(),
  unique (agent_id, version_number)
);

alter table agents add constraint agents_current_draft_fk foreign key (current_draft_id) references agent_drafts(id) on delete set null;
alter table agents add constraint agents_published_version_fk foreign key (published_version_id) references agent_versions(id) on delete set null;
alter table agent_drafts add constraint agent_drafts_base_version_fk foreign key (base_version_id) references agent_versions(id) on delete set null;

create table agent_permissions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  subject_user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('viewer', 'runner', 'editor', 'owner')),
  created_at timestamptz not null default now(),
  unique (agent_id, subject_user_id)
);

create table agent_tool_bindings (
  id uuid primary key default gen_random_uuid(),
  agent_draft_id uuid references agent_drafts(id) on delete cascade,
  agent_version_id uuid references agent_versions(id) on delete cascade,
  tool_id uuid not null references tools(id) on delete cascade,
  tool_version_id uuid references tool_versions(id) on delete set null,
  alias text not null,
  binding_config jsonb not null default '{}'::jsonb,
  policy jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  constraint agent_tool_bindings_parent_check check (
    (agent_draft_id is not null and agent_version_id is null) or (agent_draft_id is null and agent_version_id is not null)
  )
);

create table agent_knowledge_bindings (
  id uuid primary key default gen_random_uuid(),
  agent_draft_id uuid references agent_drafts(id) on delete cascade,
  agent_version_id uuid references agent_versions(id) on delete cascade,
  knowledge_base_id uuid not null references knowledge_bases(id) on delete cascade,
  binding_config jsonb not null default '{}'::jsonb,
  retrieval_override jsonb not null default '{}'::jsonb,
  constraint agent_knowledge_bindings_parent_check check (
    (agent_draft_id is not null and agent_version_id is null) or (agent_draft_id is null and agent_version_id is not null)
  )
);

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  agent_version_id uuid not null references agent_versions(id) on delete restrict,
  conversation_id uuid references conversations(id) on delete set null,
  trigger_type text not null default 'manual' check (trigger_type in ('manual', 'chat', 'api')),
  status text not null default 'queued' check (status in ('queued', 'preparing', 'running', 'waiting_input', 'completed', 'failed', 'cancelled', 'timed_out')),
  input jsonb not null default '{}'::jsonb,
  resolved_manifest jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  ended_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default now()
);

create table agent_run_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agent_runs(id) on delete cascade,
  parent_step_id uuid references agent_run_steps(id) on delete set null,
  sequence_no integer not null,
  step_type text not null check (step_type in ('system', 'llm', 'tool_call', 'tool_result', 'retrieval', 'approval', 'message')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'cancelled')),
  name text,
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (run_id, sequence_no)
);

create table agent_run_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agent_runs(id) on delete cascade,
  sequence_no integer not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, sequence_no)
);

create table usage_records (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references users(id) on delete set null,
  provider_account_id uuid references provider_accounts(id) on delete set null,
  conversation_run_id uuid references conversation_runs(id) on delete set null,
  agent_run_id uuid references agent_runs(id) on delete set null,
  provider text,
  model text,
  input_tokens integer,
  output_tokens integer,
  reasoning_tokens integer,
  search_queries integer,
  cost_usd numeric(12, 6),
  raw_usage jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table job_failures (
  id uuid primary key default gen_random_uuid(),
  queue_name text not null,
  job_name text not null,
  job_id text,
  error_message text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table announcements (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references users(id) on delete set null,
  title text not null,
  body text not null,
  severity text not null default 'info' check (severity in ('info', 'warning', 'incident')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_at timestamptz not null default now()
);
