import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RETENTION, computeCutoff, type CleanupDeps, type CleanupTarget, type ExpirableRecord } from "../src/cleanup";
import {
  resolveRetentionPolicy,
  restrictCleanupTargets,
  runCleanupJob,
  selectCleanupTargets
} from "../src/cleanup-job";

function recordingDeps(now: Date, listed: Partial<Record<CleanupTarget, ExpirableRecord[]>> = {}) {
  const listCalls: CleanupTarget[] = [];
  const deleteCalls: Array<{ target: CleanupTarget; ids: string[] }> = [];
  const deps: CleanupDeps = {
    now: () => now,
    listExpired: async (target) => {
      listCalls.push(target);
      return listed[target] ?? [];
    },
    deleteByIds: async (target, ids) => {
      deleteCalls.push({ target, ids });
      return ids.length;
    }
  };
  return { deps, listCalls, deleteCalls };
}

test("selectCleanupTargets fans 'all' out to every target", () => {
  assert.deepEqual(selectCleanupTargets("all"), ["job-failures", "completed-runs", "orphan-attachments"]);
});

test("selectCleanupTargets narrows a specific target to itself", () => {
  assert.deepEqual(selectCleanupTargets("completed-runs"), ["completed-runs"]);
});

test("selectCleanupTargets rejects an unknown target instead of skipping it", () => {
  assert.throws(
    () => selectCleanupTargets("agent-runs" as never),
    /Unknown cleanup target: agent-runs/
  );
});

test("resolveRetentionPolicy keeps the defaults when olderThanDays is absent", () => {
  assert.deepEqual(resolveRetentionPolicy(["job-failures"]), DEFAULT_RETENTION);
});

test("resolveRetentionPolicy overrides only the selected targets", () => {
  const policy = resolveRetentionPolicy(["job-failures", "orphan-attachments"], 3);
  assert.deepEqual(policy, {
    jobFailuresDays: 3,
    completedRunsDays: DEFAULT_RETENTION.completedRunsDays,
    orphanAttachmentsDays: 3
  });
});

test("resolveRetentionPolicy rejects a cutoff that would reach live rows", () => {
  for (const days of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => resolveRetentionPolicy(["job-failures"], days), /Invalid olderThanDays/);
  }
});

test("restrictCleanupTargets makes unselected targets list and delete nothing", async () => {
  const now = new Date("2026-05-29T00:00:00.000Z");
  const { deps, deleteCalls } = recordingDeps(now, {
    "job-failures": [{ id: "f1", createdAt: new Date("2026-01-01T00:00:00.000Z") }],
    "completed-runs": [{ id: "r1", createdAt: new Date("2025-01-01T00:00:00.000Z") }]
  });

  const restricted = restrictCleanupTargets(deps, ["job-failures"]);
  assert.deepEqual(await restricted.listExpired("completed-runs", now), []);
  assert.equal(await restricted.deleteByIds("completed-runs", ["r1"]), 0);
  assert.deepEqual(deleteCalls, []);

  assert.equal((await restricted.listExpired("job-failures", now)).length, 1);
  assert.equal(await restricted.deleteByIds("job-failures", ["f1"]), 1);
});

test("runCleanupJob for a single target never touches the others", async () => {
  const now = new Date("2026-05-29T00:00:00.000Z");
  const { deps, deleteCalls } = recordingDeps(now, {
    "job-failures": [{ id: "f1", createdAt: new Date("2026-01-01T00:00:00.000Z") }],
    "completed-runs": [{ id: "r1", createdAt: new Date("2025-01-01T00:00:00.000Z") }],
    "orphan-attachments": [{ id: "a1", createdAt: new Date("2026-01-01T00:00:00.000Z") }]
  });

  const report = await runCleanupJob({ target: "job-failures" }, deps);

  assert.deepEqual(report.targets, ["job-failures"]);
  assert.deepEqual(report.deleted, { "job-failures": 1 });
  assert.deepEqual(deleteCalls, [{ target: "job-failures", ids: ["f1"] }]);
  // The skipped targets are absent, not reported as zero deletions.
  assert.deepEqual(Object.keys(report.cutoffs), ["job-failures"]);
});

test("runCleanupJob for 'all' reports every target with default cutoffs", async () => {
  const now = new Date("2026-05-29T00:00:00.000Z");
  const { deps } = recordingDeps(now);

  const report = await runCleanupJob({ target: "all" }, deps);

  assert.deepEqual(report.targets, ["job-failures", "completed-runs", "orphan-attachments"]);
  assert.deepEqual(report.deleted, { "job-failures": 0, "completed-runs": 0, "orphan-attachments": 0 });
  assert.equal(report.cutoffs["completed-runs"], computeCutoff(now, DEFAULT_RETENTION.completedRunsDays).toISOString());
});

test("runCleanupJob applies olderThanDays to the selected target's cutoff", async () => {
  const now = new Date("2026-05-29T00:00:00.000Z");
  const { deps } = recordingDeps(now);

  const report = await runCleanupJob({ target: "orphan-attachments", olderThanDays: 2 }, deps);

  assert.equal(report.cutoffs["orphan-attachments"], computeCutoff(now, 2).toISOString());
});

test("runCleanupJob rejects an invalid olderThanDays before deleting anything", async () => {
  const now = new Date("2026-05-29T00:00:00.000Z");
  const { deps, deleteCalls } = recordingDeps(now, {
    "job-failures": [{ id: "f1", createdAt: new Date("2026-01-01T00:00:00.000Z") }]
  });

  await assert.rejects(() => runCleanupJob({ target: "all", olderThanDays: 0 }, deps), /Invalid olderThanDays/);
  assert.deepEqual(deleteCalls, []);
});
