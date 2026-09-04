import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchAgentRun } from "../src/lib/agent-run-dispatch";

test("a run that enqueues is handed to the worker and not executed in process", async () => {
  let enqueued = 0;
  let detached = 0;

  const result = await dispatchAgentRun({
    enqueue: async () => {
      enqueued += 1;
    },
    executeDetached: () => {
      detached += 1;
    }
  }, { runId: "run-1" });

  assert.deepEqual(result, { mode: "queued" });
  assert.equal(enqueued, 1);
  assert.equal(detached, 0, "a queued run must not also run in this process");
});

test("an enqueue failure falls back to in-process execution instead of failing the caller", async () => {
  let detached = 0;

  const result = await dispatchAgentRun({
    enqueue: async () => {
      throw new Error("agent-run enqueue timed out after 5000ms");
    },
    executeDetached: () => {
      detached += 1;
    }
  }, { runId: "run-1" });

  assert.deepEqual(result, { mode: "in_process", reason: "agent-run enqueue timed out after 5000ms" });
  assert.equal(detached, 1, "degrading beats refusing: the run still has to execute");
});

test("a non-Error enqueue rejection still falls back and keeps a reason", async () => {
  let detached = 0;

  const result = await dispatchAgentRun({
    enqueue: async () => {
      throw "ECONNREFUSED";
    },
    executeDetached: () => {
      detached += 1;
    }
  }, { runId: "run-1" });

  assert.deepEqual(result, { mode: "in_process", reason: "ECONNREFUSED" });
  assert.equal(detached, 1);
});
