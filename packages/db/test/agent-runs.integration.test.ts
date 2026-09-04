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
      and status in ('queued', 'preparing', 'running')
      and coalesce(started_at, created_at) < now() - ${`${MAX_RUN_AGE_MINUTES} minutes`}::interval
    returning id, status, error_code
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

test("every non-terminal status is reachable by the reconcile predicate", skipWithoutDatabase, async () => {
  for (const status of ["queued", "preparing", "running"]) {
    const { runId } = await seedRun(status, 45);
    const rows = await reconcile(runId);
    assert.equal(rows.length, 1, `${status} should reconcile`);
  }

  // waiting_input is deliberately excluded: it is blocked on a human, not
  // abandoned, and reaping it would discard a pending approval.
  const { runId } = await seedRun("waiting_input", 45);
  const rows = await reconcile(runId);
  assert.equal(rows.length, 0, "waiting_input must not be reaped");
});
