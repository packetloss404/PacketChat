import assert from "node:assert/strict";
import { test } from "node:test";
import { createCleanupDeps, type CleanupSql } from "../src/cleanup-deps";
import type { CleanupTarget } from "../src/cleanup";

type Recorded = { text: string; values: unknown[] };

// Stands in for the postgres.js client: records the tagged-template query text
// and its bound values, and answers each query from `respond`. The array form
// (`sql(ids)`) returns a marker so tests can see which ids each batch carried.
function createFakeSql(respond: (query: Recorded, index: number) => unknown[] = () => []) {
  const calls: Recorded[] = [];
  const lists: string[][] = [];

  const fake = (first: unknown, ...rest: unknown[]) => {
    if (Array.isArray(first) && !("raw" in Object(first))) {
      const list = first as string[];
      lists.push(list);
      return { list };
    }

    const strings = first as TemplateStringsArray;
    const record: Recorded = { text: strings.join(" ? ").replace(/\s+/g, " ").trim(), values: rest };
    calls.push(record);
    return Promise.resolve(respond(record, calls.length - 1));
  };

  return { sql: fake as unknown as CleanupSql, calls, lists };
}

// Bound values minus the `sql(...)` list markers, which the tests inspect
// separately through `lists`.
function boundScalars(query: Recorded) {
  return query.values.filter((value) => !(typeof value === "object" && value !== null && "list" in value));
}

function idRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: `id-${index}` }));
}

test("now returns the current time", () => {
  const before = Date.now();
  const now = createCleanupDeps(createFakeSql().sql).now();
  assert.ok(now instanceof Date);
  assert.ok(now.getTime() >= before);
  assert.ok(now.getTime() <= Date.now());
});

test("listExpired reads job_failures older than the cutoff", async () => {
  const cutoff = new Date("2026-05-22T00:00:00.000Z");
  const fake = createFakeSql(() => [
    { id: "f1", created_at: new Date("2026-01-01T00:00:00.000Z") },
    { id: "f2", created_at: "2026-01-02T00:00:00.000Z" }
  ]);

  const records = await createCleanupDeps(fake.sql).listExpired("job-failures", cutoff);

  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0]!.text, /from job_failures/);
  assert.match(fake.calls[0]!.text, /created_at < \?/);
  assert.deepEqual(fake.calls[0]!.values, [cutoff, 5000]);
  assert.deepEqual(
    records.map((record) => record.id),
    ["f1", "f2"]
  );
  // Timestamps arrive as Date objects even when the driver hands back strings.
  assert.ok(records[1]!.createdAt instanceof Date);
  assert.equal(records[1]!.createdAt.toISOString(), "2026-01-02T00:00:00.000Z");
});

test("listExpired only selects terminal agent runs", async () => {
  const cutoff = new Date("2026-03-01T00:00:00.000Z");
  const fake = createFakeSql(() => []);

  await createCleanupDeps(fake.sql).listExpired("completed-runs", cutoff);

  const query = fake.calls[0]!;
  assert.match(query.text, /from agent_runs/);
  assert.match(query.text, /status in/);
  assert.deepEqual(fake.lists[0], ["completed", "failed", "cancelled", "timed_out"]);
  for (const live of ["queued", "preparing", "running", "waiting_input"]) {
    assert.ok(!fake.lists[0]!.includes(live), `${live} must never be selected for deletion`);
  }
  // A run that started long ago but only finished recently is still protected.
  assert.match(query.text, /coalesce\(ended_at, created_at\) < \?/);
  assert.deepEqual(boundScalars(query), [cutoff, cutoff, 5000]);
});

test("listExpired only selects unreferenced attachments", async () => {
  const cutoff = new Date("2026-05-22T00:00:00.000Z");
  const fake = createFakeSql(() => []);

  await createCleanupDeps(fake.sql).listExpired("orphan-attachments", cutoff);

  const query = fake.calls[0]!;
  assert.match(query.text, /from attachments as a/);
  assert.match(query.text, /a\.conversation_id is null/);
  assert.match(query.text, /a\.message_id is null/);
  assert.match(query.text, /a\.metadata->>'purpose' is distinct from 'chat_attachment'/);
  assert.match(query.text, /not exists \( select 1 from knowledge_documents kd where kd\.attachment_id = a\.id \)/);
  assert.deepEqual(query.values, [cutoff, "processing", 5000]);
});

test("a referenced chat attachment is not selected or deleted while a true orphan is", async () => {
  // Two ownerless attachments past the cutoff. `chat-1` only has a message
  // metadata reference, so its conversation_id/message_id are null. The fake
  // honours the generated predicate: it spares the chat attachment only when
  // the query actually carries the purpose guard, so removing the guard makes
  // this test fail on both the list and the delete.
  const fixture = [
    {
      id: "chat-1",
      bucket: "uploads",
      object_key: "chat-key",
      conversation_id: null,
      message_id: null,
      status: "ready",
      purpose: "chat_attachment",
      created_at: new Date("2026-01-01T00:00:00.000Z")
    },
    {
      id: "orphan-1",
      bucket: "uploads",
      object_key: "orphan-key",
      conversation_id: null,
      message_id: null,
      status: "ready",
      purpose: null,
      created_at: new Date("2026-01-02T00:00:00.000Z")
    }
  ];
  const guardPresent = (query: Recorded) => query.text.includes("a.metadata->>'purpose' is distinct from 'chat_attachment'");

  const fake = createFakeSql((query) => {
    const rows = fixture.filter((row) => !(guardPresent(query) && row.purpose === "chat_attachment"));
    if (query.text.startsWith("delete")) return rows.map((row) => ({ id: row.id }));
    if (query.text.includes("select a.id, a.created_at")) return rows.map((row) => ({ id: row.id, created_at: row.created_at }));
    return rows.map((row) => ({ id: row.id, bucket: row.bucket, object_key: row.object_key }));
  });

  const deps = createCleanupDeps(fake.sql, async () => {});
  const listed = await deps.listExpired("orphan-attachments", new Date("2026-06-01T00:00:00.000Z"));
  assert.deepEqual(listed.map((record) => record.id), ["orphan-1"]);

  const deleted = await deps.deleteByIds("orphan-attachments", ["chat-1", "orphan-1"]);
  assert.equal(deleted, 1);
});

test("deleteByIds is a no-op for an empty id list", async () => {
  const fake = createFakeSql(() => {
    throw new Error("no query should be issued");
  });

  const deleted = await createCleanupDeps(fake.sql).deleteByIds("job-failures", []);

  assert.equal(deleted, 0);
  assert.equal(fake.calls.length, 0);
});

test("deleteByIds batches large id lists and sums the rows actually deleted", async () => {
  const ids = Array.from({ length: 1200 }, (_, index) => `a-${index}`);
  // Second batch reports fewer deletions than requested, as it would when rows
  // vanished or stopped matching the safety predicate between list and delete.
  const rowsPerCall = [500, 480, 200];
  const fake = createFakeSql((_query, index) => idRows(rowsPerCall[index] ?? 0));

  const deleted = await createCleanupDeps(fake.sql).deleteByIds("job-failures", ids);

  assert.equal(deleted, 1180);
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(
    fake.lists.map((list) => list.length),
    [500, 500, 200]
  );
  assert.equal(fake.lists[0]![0], "a-0");
  assert.equal(fake.lists[2]![199], "a-1199");
  for (const call of fake.calls) {
    assert.match(call.text, /delete from job_failures/);
    assert.match(call.text, /returning id/);
  }
});

test("deleteByIds re-checks the terminal status when deleting agent runs", async () => {
  const fake = createFakeSql(() => idRows(1));

  const deleted = await createCleanupDeps(fake.sql).deleteByIds("completed-runs", ["r1"]);

  assert.equal(deleted, 1);
  assert.match(fake.calls[0]!.text, /delete from agent_runs/);
  assert.match(fake.calls[0]!.text, /and status in/);
  assert.deepEqual(fake.lists[0], ["r1"]);
  assert.deepEqual(fake.lists[1], ["completed", "failed", "cancelled", "timed_out"]);
});

test("deleteByIds re-checks the orphan predicate when deleting attachments", async () => {
  // First call selects the candidates, second performs the delete.
  let call = 0;
  const fake = createFakeSql(() => {
    call += 1;
    return call === 1
      ? [
          { id: "a1", bucket: "uploads", object_key: "k1" },
          { id: "a2", bucket: "uploads", object_key: "k2" }
        ]
      : idRows(2);
  });

  const deleted = await createCleanupDeps(fake.sql, async () => {}).deleteByIds("orphan-attachments", ["a1", "a2", "a3"]);

  // Only the rows the database reported back are counted, not the ids sent.
  assert.equal(deleted, 2);
  const query = fake.calls[fake.calls.length - 1]!;
  assert.match(query.text, /delete from attachments as a/);
  assert.match(query.text, /a\.conversation_id is null/);
  assert.match(query.text, /a\.message_id is null/);
  assert.match(query.text, /a\.metadata->>'purpose' is distinct from 'chat_attachment'/);
  assert.match(query.text, /not exists \( select 1 from knowledge_documents kd where kd\.attachment_id = a\.id \)/);
  assert.deepEqual(boundScalars(query), ["processing"]);

  // The candidate select must carry the same guard as the final delete.
  const candidateSelect = fake.calls[fake.calls.length - 2]!;
  assert.match(candidateSelect.text, /a\.metadata->>'purpose' is distinct from 'chat_attachment'/);
});

test("the storage object is purged before the attachment row is deleted", async () => {
  const order: string[] = [];
  let call = 0;
  const fake = createFakeSql((query) => {
    call += 1;
    order.push(query.text.includes("delete from attachments") ? "delete-row" : "select-candidates");
    return call === 1 ? [{ id: "a1", bucket: "uploads", object_key: "k1" }] : idRows(1);
  });

  const purged: Array<[string, string]> = [];
  const deleted = await createCleanupDeps(fake.sql, async (bucket, key) => {
    order.push("purge-object");
    purged.push([bucket, key]);
  }).deleteByIds("orphan-attachments", ["a1"]);

  assert.equal(deleted, 1);
  assert.deepEqual(purged, [["uploads", "k1"]]);
  // The row must never be deleted before its object: bucket/object_key exist
  // nowhere else, so losing the row first strands the object unidentifiably.
  assert.deepEqual(order, ["select-candidates", "purge-object", "delete-row"]);
});

test("an attachment whose object cannot be deleted keeps its row for a later run", async () => {
  const fake = createFakeSql(() => [{ id: "a1", bucket: "uploads", object_key: "k1" }]);

  const deleted = await createCleanupDeps(fake.sql, async () => {
    throw new Error("storage unavailable");
  }).deleteByIds("orphan-attachments", ["a1"]);

  assert.equal(deleted, 0);
  // Only the candidate select ran; no delete was issued.
  assert.equal(fake.calls.length, 1);
  assert.ok(!fake.calls[0]!.text.includes("delete from attachments"));
});

test("unknown targets are rejected instead of silently doing nothing", async () => {
  const fake = createFakeSql(() => []);
  const deps = createCleanupDeps(fake.sql);
  const bogus = "everything" as CleanupTarget;

  await assert.rejects(() => deps.listExpired(bogus, new Date()), /Unknown cleanup target/);
  await assert.rejects(() => deps.deleteByIds(bogus, ["x"]), /Unknown cleanup target/);
  assert.equal(fake.calls.length, 0);
});
