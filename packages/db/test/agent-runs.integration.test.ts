import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { createTestDatabase, hasTestDatabase, skipWithoutDatabase, type TestDatabase } from "./integration-helpers";

// Detached agent runs execute inside the web process, so a restart can strand a
// run in a non-terminal state with nothing left to finish it. The single-run GET
// reconciles that on read. The predicate is only trustworthy if a real Postgres
// agrees with it, which is what these assert.

const MAX_RUN_AGE_MINUTES = 20;

let db: TestDatabase | undefined;

before(async () => {
  if (!hasTestDatabase) return;
  db = await createTestDatabase();
});

after(async () => {
  await db?.close();
});

async function seedRun(status: string, ageMinutes: number) {
  const sql = db!.sql;
  const [user] = await sql<{ id: string }[]>`
    insert into users (email, display_name, role, status)
    values (${`${randomUUID()}@example.test`}, 'Runner', 'admin', 'active')
    returning id
  `;
  const [agent] = await sql<{ id: string }[]>`
    insert into agents (owner_user_id, name, description, status)
    values (${user!.id}, 'Test agent', 'fixture', 'active')
    returning id
  `;
  const [version] = await sql<{ id: string }[]>`
    insert into agent_versions (agent_id, owner_user_id, version_number, spec, manifest, content_hash)
    values (${agent!.id}, ${user!.id}, 1, '{}'::jsonb, '{}'::jsonb, ${randomUUID()})
    returning id
  `;
  const [run] = await sql<{ id: string }[]>`
    insert into agent_runs (owner_user_id, agent_id, agent_version_id, status, started_at, created_at)
    values (
      ${user!.id}, ${agent!.id}, ${version!.id}, ${status},
      now() - ${`${ageMinutes} minutes`}::interval,
      now() - ${`${ageMinutes} minutes`}::interval
    )
    returning id
  `;
  return { runId: run!.id, userId: user!.id, agentId: agent!.id };
}

async function reconcile(runId: string) {
  return db!.sql`
    update agent_runs
    set status = 'timed_out',
        ended_at = now(),
        error_code = coalesce(error_code, 'run_abandoned'),
        error_message = coalesce(error_message, 'Run exceeded the maximum duration or its process ended before completing.')
    where id = ${runId}
      and status in ('preparing', 'running')
      and started_at is not null
      and started_at < now() - ${`${MAX_RUN_AGE_MINUTES} minutes`}::interval
    returning id, status, error_code
  `;
}

// Mirrors claimRunForExecution in packages/agent-runtime/src/deps.ts.
async function claim(runId: string) {
  return db!.sql`
    with claimed as (
      update agent_runs set status = 'running', started_at = now()
      where id = ${runId} and status in ('queued', 'preparing')
      returning id
    )
    select (select count(*) from claimed)::integer as claimed,
           (select status from agent_runs where id = ${runId} for share) as status
  `;
}

test("a run stranded past the cap is failed on read", skipWithoutDatabase, async () => {
  const { runId } = await seedRun("running", 45);
  const rows = await reconcile(runId);

  assert.equal(rows.length, 1, "a stranded run must be reconciled");
  assert.equal(rows[0]!.status, "timed_out");
  assert.equal(rows[0]!.error_code, "run_abandoned");
});

test("a run still inside the cap is left alone", skipWithoutDatabase, async () => {
  const { runId } = await seedRun("running", 5);
  const rows = await reconcile(runId);

  assert.equal(rows.length, 0, "a run that may still be working must not be reaped");
  const [current] = await db!.sql<{ status: string }[]>`select status from agent_runs where id = ${runId}`;
  assert.equal(current!.status, "running");
});

test("an already-completed run is never rewritten", skipWithoutDatabase, async () => {
  const { runId } = await seedRun("completed", 90);
  const rows = await reconcile(runId);

  assert.equal(rows.length, 0, "terminal runs are outside the predicate");
  const [current] = await db!.sql<{ status: string }[]>`select status from agent_runs where id = ${runId}`;
  assert.equal(current!.status, "completed", "a finished run must keep its outcome");
});

test("a queued run is never reaped for waiting in the queue", skipWithoutDatabase, async () => {
  // A queued run has not started. Measuring from created_at timed out jobs for
  // sitting in Redis while the worker was redeployed, and because the claim only
  // accepts queued/preparing the job then came back to a run it could never
  // execute - the caller was left with no assistant message at all.
  const sql = db!.sql;
  const { runId } = await seedRun("queued", 120);
  await sql`update agent_runs set started_at = null where id = ${runId}`;

  const reaped = await reconcile(runId);
  assert.equal(reaped.length, 0, "queue wait must not time a run out");

  const claimed = await claim(runId);
  assert.equal(claimed[0]!.claimed, 1, "the run must still be claimable after a long queue wait");
});

test("the claim is race-safe and reports the settled status to the loser", skipWithoutDatabase, async () => {
  const { runId } = await seedRun("queued", 1);
  await db!.sql`update agent_runs set started_at = null where id = ${runId}`;

  const first = await claim(runId);
  assert.equal(first[0]!.claimed, 1, "the first claim wins");

  const second = await claim(runId);
  assert.equal(second[0]!.claimed, 0, "a second claim must not re-run the same run");
  assert.equal(second[0]!.status, "running", "the loser must see the settled status, not a stale snapshot");
});

test("every non-terminal status is reachable by the reconcile predicate", skipWithoutDatabase, async () => {
  for (const status of ["preparing", "running"]) {
    const { runId } = await seedRun(status, 45);
    const rows = await reconcile(runId);
    assert.equal(rows.length, 1, `${status} should reconcile`);
  }

  // waiting_input is deliberately excluded: it is blocked on a human, not
  // abandoned, and reaping it would discard a pending approval. queued is
  // excluded too - it has not started, so there is nothing to time out.
  for (const status of ["waiting_input", "queued"]) {
    const { runId } = await seedRun(status, 45);
    const rows = await reconcile(runId);
    assert.equal(rows.length, 0, `${status} must not be reaped`);
  }
});
