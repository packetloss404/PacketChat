import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { createTestDatabase, hasTestDatabase, skipWithoutDatabase, type TestDatabase } from "./integration-helpers";

// A queued agent run is executed by whichever process gets to it first: the
// worker, or the web route falling back in process when the enqueue failed. Both
// take ownership with the statement below, and BullMQ can deliver the same job
// more than once. Only a real Postgres can show that the claim is a single
// atomic act rather than a check followed by a write, so these assert it there.
//
// This is the same statement as claimRunForExecution in
// packages/agent-runtime/src/deps.ts, kept here so the SQL is exercised without
// the runtime's global connection, in the style of agent-runs.integration.test.ts.

let db: TestDatabase | undefined;

before(async () => {
  if (!hasTestDatabase) return;
  db = await createTestDatabase();
});

after(async () => {
  await db?.close();
});

async function seedRun(status: string, resolved: { providerAccountId: string | null; model: string | null }) {
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
    insert into agent_runs (owner_user_id, agent_id, agent_version_id, status, input, resolved_provider_account_id, resolved_model)
    values (
      ${user!.id},
      ${agent!.id},
      ${version!.id},
      ${status},
      ${JSON.stringify({ text: "hello" })}::jsonb,
      ${resolved.providerAccountId},
      ${resolved.model}
    )
    returning id
  `;
  return { runId: run!.id, userId: user!.id, agentId: agent!.id };
}

async function claim(runId: string) {
  const rows = await db!.sql<{ claimed: number; status: string | null }[]>`
    with claimed as (
      update agent_runs
      set status = 'running', started_at = now()
      where id = ${runId}
        and status in ('queued', 'preparing')
      returning id
    )
    select
      (select count(*) from claimed)::integer as claimed,
      (select status from agent_runs where id = ${runId}) as status
  `;
  return rows[0]!;
}

test("the resolved provider binding round-trips on the run row", skipWithoutDatabase, async () => {
  const providerAccountId = randomUUID();
  const { runId } = await seedRun("queued", { providerAccountId, model: "gpt-test-1" });

  const [row] = await db!.sql<{ resolved_provider_account_id: string | null; resolved_model: string | null }[]>`
    select resolved_provider_account_id, resolved_model from agent_runs where id = ${runId}
  `;

  assert.equal(row!.resolved_provider_account_id, providerAccountId);
  assert.equal(row!.resolved_model, "gpt-test-1");
});

test("a run created before the binding columns existed keeps nulls", skipWithoutDatabase, async () => {
  const { runId } = await seedRun("queued", { providerAccountId: null, model: null });

  const [row] = await db!.sql<{ resolved_provider_account_id: string | null; resolved_model: string | null }[]>`
    select resolved_provider_account_id, resolved_model from agent_runs where id = ${runId}
  `;

  // The worker refuses these rather than re-resolving a binding the caller
  // never asked for; the columns must stay nullable for that to be expressible.
  assert.equal(row!.resolved_provider_account_id, null);
  assert.equal(row!.resolved_model, null);
});

test("claiming a queued run takes it and starts the clock", skipWithoutDatabase, async () => {
  const { runId } = await seedRun("queued", { providerAccountId: randomUUID(), model: "m" });

  const result = await claim(runId);

  assert.equal(result.claimed, 1);
  const [row] = await db!.sql<{ status: string; started_at: string | null }[]>`
    select status, started_at from agent_runs where id = ${runId}
  `;
  assert.equal(row!.status, "running");
  assert.notEqual(row!.started_at, null, "the reconcile clock starts at execution, not at creation");
});

test("a second claim of the same run is refused and reports what it found", skipWithoutDatabase, async () => {
  const { runId } = await seedRun("queued", { providerAccountId: randomUUID(), model: "m" });

  assert.equal((await claim(runId)).claimed, 1);
  const second = await claim(runId);

  assert.equal(second.claimed, 0, "a redelivered job must not re-execute a claimed run");
  assert.equal(second.status, "running");
});

test("a run that already finished cannot be reclaimed by a retry", skipWithoutDatabase, async () => {
  for (const status of ["completed", "failed", "cancelled", "timed_out", "running", "waiting_input"]) {
    const { runId } = await seedRun(status, { providerAccountId: randomUUID(), model: "m" });
    const result = await claim(runId);
    assert.equal(result.claimed, 0, `${status} must not be claimable`);
    assert.equal(result.status, status, `${status} must be left exactly as it was`);
  }
});

test("concurrent claims of one run produce exactly one winner", skipWithoutDatabase, async () => {
  const { runId } = await seedRun("queued", { providerAccountId: randomUUID(), model: "m" });

  const results = await Promise.all([claim(runId), claim(runId), claim(runId)]);
  const winners = results.filter((result) => result.claimed === 1);

  assert.equal(winners.length, 1, "the claim must be atomic, not a check followed by a write");
});

test("a claim of a run that no longer exists reports nothing rather than inventing a status", skipWithoutDatabase, async () => {
  const result = await claim(randomUUID());

  assert.equal(result.claimed, 0);
  assert.equal(result.status, null);
});
