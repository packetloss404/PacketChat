import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { createTestDatabase, skipWithoutDatabase, type TestDatabase } from "./integration-helpers";

// The PacketAgent tables are only trustworthy if the unique indexes the
// idempotency rules rely on actually exist in Postgres. Each test replays every
// migration into a throwaway schema and asserts the constraints directly.

let db: TestDatabase | undefined;

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await createTestDatabase();
});

after(async () => {
  await db?.close();
});

async function seedProject() {
  const sql = db!.sql;
  const [user] = await sql<{ id: string }[]>`
    insert into users (email, display_name, role, status)
    values (${`${randomUUID()}@example.test`}, 'PA Owner', 'user', 'active')
    returning id
  `;
  const [project] = await sql<{ id: string }[]>`
    insert into projects (owner_user_id, name)
    values (${user!.id}, 'PacketAgent project')
    returning id
  `;
  return { userId: user!.id, projectId: project!.id };
}

async function seedConnection(projectId: string, userId: string, workspaceId = "workspace-1") {
  const sql = db!.sql;
  const [connection] = await sql<{ id: string }[]>`
    insert into packet_agent_connections (
      project_id, owner_user_id, name, workspace_id, agent_base_url, agent_credentials,
      ingest_token_digest, ingest_token_prefix
    ) values (
      ${projectId}, ${userId}, 'Prod', ${workspaceId}, 'https://agent.example.test',
      ${JSON.stringify({ alg: "A256GCM", iv: "x", tag: "y", ciphertext: "z" })}::jsonb,
      'v1:digest', 'prefix12'
    )
    returning id
  `;
  return connection!.id;
}

function cardValues(connectionId: string, projectId: string, userId: string, workerRunId: string) {
  return {
    connectionId,
    projectId,
    userId,
    workerRunId
  };
}

test("a connection and run card persist and map to the project owner", skipWithoutDatabase, async () => {
  const { projectId, userId } = await seedProject();
  const connectionId = await seedConnection(projectId, userId);
  const value = cardValues(connectionId, projectId, userId, "run-1");

  await db!.sql`
    insert into packet_agent_runs (
      connection_id, project_id, owner_user_id, workspace_id, thread_key,
      worker_run_id, worker_definition_id, worker_deployment_id, worker_version_id,
      worker_version_content_digest, title, summary, state, budget, checkpoint,
      required_action, evidence, callbacks
    ) values (
      ${value.connectionId}, ${value.projectId}, ${value.userId}, 'workspace-1', 'worker-run:run-1',
      ${value.workerRunId}, 'definition-1', 'deployment-1', 'version-1',
      'digest-1', 'Worker run', 'Working', '{"run":"running"}'::jsonb, '{"usage":{}}'::jsonb, null,
      'none', '{}'::jsonb, '{"alg":"A256GCM","iv":"x","tag":"y","ciphertext":"z"}'::jsonb
    )
  `;

  const [run] = await db!.sql<{ project_id: string; owner_user_id: string }[]>`
    select project_id, owner_user_id from packet_agent_runs where connection_id = ${connectionId} and worker_run_id = 'run-1'
  `;
  assert.equal(run!.project_id, projectId);
  assert.equal(run!.owner_user_id, userId);
});

test("the (connection_id, worker_run_id) unique index collapses a replayed card upsert", skipWithoutDatabase, async () => {
  const { projectId, userId } = await seedProject();
  const connectionId = await seedConnection(projectId, userId);
  const value = cardValues(connectionId, projectId, userId, "run-dup");

  const insert = () => db!.sql`
    insert into packet_agent_runs (
      connection_id, project_id, owner_user_id, workspace_id, thread_key,
      worker_run_id, worker_definition_id, worker_deployment_id, worker_version_id,
      worker_version_content_digest, title, summary, state, budget, checkpoint,
      required_action, evidence, callbacks
    ) values (
      ${value.connectionId}, ${value.projectId}, ${value.userId}, 'workspace-1', 'worker-run:run-dup',
      ${value.workerRunId}, 'definition-1', 'deployment-1', 'version-1',
      'digest-1', 'Worker run', 'Working', '{"run":"running"}'::jsonb, '{"usage":{}}'::jsonb, null,
      'none', '{}'::jsonb, '{}'::jsonb
    )
    on conflict (connection_id, worker_run_id) do update set summary = excluded.summary
    returning id
  `;

  const first = await insert();
  const second = await insert();
  assert.equal(first[0]!.id, second[0]!.id);

  const [{ count }] = await db!.sql<{ count: number }[]>`
    select count(*)::integer as count from packet_agent_runs where connection_id = ${connectionId} and worker_run_id = 'run-dup'
  `;
  assert.equal(count, 1);
});

test("the (connection_id, message_key) unique index makes a redelivered event a no-op", skipWithoutDatabase, async () => {
  const { projectId, userId } = await seedProject();
  const connectionId = await seedConnection(projectId, userId);
  const [run] = await db!.sql<{ id: string }[]>`
    insert into packet_agent_runs (
      connection_id, project_id, owner_user_id, workspace_id, thread_key,
      worker_run_id, worker_definition_id, worker_deployment_id, worker_version_id,
      worker_version_content_digest, title, summary, state, budget, checkpoint,
      required_action, evidence, callbacks
    ) values (
      ${connectionId}, ${projectId}, ${userId}, 'workspace-1', 'worker-run:run-evt',
      'run-evt', 'definition-1', 'deployment-1', 'version-1',
      'digest-1', 'Worker run', 'Working', '{"run":"running"}'::jsonb, '{"usage":{}}'::jsonb, null,
      'none', '{}'::jsonb, '{}'::jsonb
    )
    returning id
  `;

  const insert = () => db!.sql`
    insert into packet_agent_run_events (run_id, connection_id, message_key, idempotency_key, event, payload)
    values (${run!.id}, ${connectionId}, 'msg-1', 'delivery-1', 'progress', '{}'::jsonb)
    on conflict (connection_id, message_key) do nothing
    returning id
  `;

  assert.equal((await insert()).length, 1);
  assert.equal((await insert()).length, 0, "a redelivered message key must not create a second event");

  const [{ count }] = await db!.sql<{ count: number }[]>`
    select count(*)::integer as count from packet_agent_run_events where connection_id = ${connectionId} and message_key = 'msg-1'
  `;
  assert.equal(count, 1);
});

test("deleting the connection cascades its runs and events", skipWithoutDatabase, async () => {
  const { projectId, userId } = await seedProject();
  const connectionId = await seedConnection(projectId, userId);
  const [run] = await db!.sql<{ id: string }[]>`
    insert into packet_agent_runs (
      connection_id, project_id, owner_user_id, workspace_id, thread_key,
      worker_run_id, worker_definition_id, worker_deployment_id, worker_version_id,
      worker_version_content_digest, title, summary, state, budget, checkpoint,
      required_action, evidence, callbacks
    ) values (
      ${connectionId}, ${projectId}, ${userId}, 'workspace-1', 'worker-run:run-cascade',
      'run-cascade', 'definition-1', 'deployment-1', 'version-1',
      'digest-1', 'Worker run', 'Working', '{"run":"running"}'::jsonb, '{"usage":{}}'::jsonb, null,
      'none', '{}'::jsonb, '{}'::jsonb
    )
    returning id
  `;
  await db!.sql`
    insert into packet_agent_run_events (run_id, connection_id, message_key, idempotency_key, event, payload)
    values (${run!.id}, ${connectionId}, 'msg-cascade', 'delivery-cascade', 'progress', '{}'::jsonb)
  `;

  await db!.sql`delete from packet_agent_connections where id = ${connectionId}`;

  const runs = await db!.sql`select id from packet_agent_runs where connection_id = ${connectionId}`;
  const events = await db!.sql`select id from packet_agent_run_events where connection_id = ${connectionId}`;
  assert.equal(runs.length, 0);
  assert.equal(events.length, 0);
});
