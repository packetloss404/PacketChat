import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeCutoff,
  runCleanup,
  selectExpired,
  DEFAULT_RETENTION,
  type CleanupDeps,
  type CleanupTarget,
  type ExpirableRecord
} from "../src/cleanup";

test("computeCutoff subtracts the given number of days from now", () => {
  const now = new Date("2026-05-29T00:00:00.000Z");
  const cutoff = computeCutoff(now, 7);
  assert.equal(cutoff.toISOString(), "2026-05-22T00:00:00.000Z");
});

test("selectExpired treats a record exactly at the cutoff as not expired", () => {
  const cutoff = new Date("2026-05-22T00:00:00.000Z");
  const records: ExpirableRecord[] = [
    { id: "before", createdAt: new Date("2026-05-21T23:59:59.999Z") },
    { id: "exact", createdAt: new Date("2026-05-22T00:00:00.000Z") },
    { id: "after", createdAt: new Date("2026-05-22T00:00:00.001Z") }
  ];

  const expired = selectExpired(records, cutoff);
  assert.deepEqual(
    expired.map((r) => r.id),
    ["before"]
  );
});

test("runCleanup sums deletes across targets and reports ISO cutoffs", async () => {
  const now = new Date("2026-05-29T00:00:00.000Z");
  const listed: Record<CleanupTarget, ExpirableRecord[]> = {
    "job-failures": [
      { id: "f1", createdAt: new Date("2026-01-01T00:00:00.000Z") },
      { id: "f2", createdAt: new Date("2026-01-02T00:00:00.000Z") }
    ],
    "completed-runs": [{ id: "r1", createdAt: new Date("2025-01-01T00:00:00.000Z") }],
    "orphan-attachments": [
      { id: "a1", createdAt: new Date("2026-05-01T00:00:00.000Z") },
      { id: "a2", createdAt: new Date("2026-05-02T00:00:00.000Z") },
      { id: "a3", createdAt: new Date("2026-05-03T00:00:00.000Z") }
    ]
  };

  const deleteCalls: Array<{ target: CleanupTarget; ids: string[] }> = [];
  const deps: CleanupDeps = {
    now: () => now,
    listExpired: async (target) => listed[target],
    deleteByIds: async (target, ids) => {
      deleteCalls.push({ target, ids });
      return ids.length;
    }
  };

  const summary = await runCleanup(deps);

  assert.deepEqual(summary.deleted, {
    "job-failures": 2,
    "completed-runs": 1,
    "orphan-attachments": 3
  });
  assert.equal(summary.cutoffs["job-failures"], computeCutoff(now, DEFAULT_RETENTION.jobFailuresDays).toISOString());
  assert.equal(summary.cutoffs["completed-runs"], computeCutoff(now, DEFAULT_RETENTION.completedRunsDays).toISOString());
  assert.equal(
    summary.cutoffs["orphan-attachments"],
    computeCutoff(now, DEFAULT_RETENTION.orphanAttachmentsDays).toISOString()
  );
  assert.equal(deleteCalls.length, 3);
});

test("runCleanup skips deleteByIds when there are zero expired records", async () => {
  const now = new Date("2026-05-29T00:00:00.000Z");
  let deleteCalled = false;
  const deps: CleanupDeps = {
    now: () => now,
    listExpired: async () => [],
    deleteByIds: async () => {
      deleteCalled = true;
      return 0;
    }
  };

  const summary = await runCleanup(deps);

  assert.equal(deleteCalled, false);
  assert.deepEqual(summary.deleted, {
    "job-failures": 0,
    "completed-runs": 0,
    "orphan-attachments": 0
  });
});

test("runCleanup honors a custom retention policy", async () => {
  const now = new Date("2026-05-29T00:00:00.000Z");
  const deps: CleanupDeps = {
    now: () => now,
    listExpired: async () => [],
    deleteByIds: async () => 0
  };

  const summary = await runCleanup(deps, {
    jobFailuresDays: 1,
    completedRunsDays: 2,
    orphanAttachmentsDays: 3
  });

  assert.equal(summary.cutoffs["job-failures"], computeCutoff(now, 1).toISOString());
  assert.equal(summary.cutoffs["completed-runs"], computeCutoff(now, 2).toISOString());
  assert.equal(summary.cutoffs["orphan-attachments"], computeCutoff(now, 3).toISOString());
});
