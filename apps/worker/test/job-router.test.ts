import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertKnownJobName,
  assertWorkerQueue,
  isWorkerQueue,
  routeJob,
  UnknownJobError,
  WORKER_QUEUE_NAMES,
  type WorkerQueueName
} from "../src/job-router";

test("isWorkerQueue returns true for known queues and false otherwise", () => {
  for (const name of WORKER_QUEUE_NAMES) {
    assert.equal(isWorkerQueue(name), true);
  }
  assert.equal(isWorkerQueue("nope"), false);
  assert.equal(isWorkerQueue(""), false);
});

test("assertWorkerQueue narrows known names and throws UnknownJobError for unknown", () => {
  assert.equal(assertWorkerQueue("agent-run"), "agent-run");

  assert.throws(
    () => assertWorkerQueue("mystery"),
    (error: unknown) => {
      assert.ok(error instanceof UnknownJobError);
      assert.equal(error.queueName, "mystery");
      assert.equal(error.jobName, undefined);
      return true;
    }
  );
});

test("routeJob returns the handler for the queue and throws on unknown queue", () => {
  const handlers: Record<WorkerQueueName, string> = {
    "provider-sync": "sync",
    "file-ingestion": "ingest",
    "agent-run": "run",
    cleanup: "clean"
  };

  assert.equal(routeJob("file-ingestion", handlers), "ingest");
  assert.equal(routeJob("cleanup", handlers), "clean");

  assert.throws(
    () => routeJob("ghost-queue", handlers),
    (error: unknown) => {
      assert.ok(error instanceof UnknownJobError);
      assert.equal(error.queueName, "ghost-queue");
      return true;
    }
  );
});

test("assertKnownJobName passes for allowed names and throws for bad ones", () => {
  assert.doesNotThrow(() => assertKnownJobName("agent-run", "start", ["start", "stop"]));

  assert.throws(
    () => assertKnownJobName("agent-run", "explode", ["start", "stop"]),
    (error: unknown) => {
      assert.ok(error instanceof UnknownJobError);
      assert.equal(error.queueName, "agent-run");
      assert.equal(error.jobName, "explode");
      return true;
    }
  );
});

test("UnknownJobError carries queueName and jobName and reads as an Error", () => {
  const error = new UnknownJobError("provider-sync", "weird-job");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "UnknownJobError");
  assert.equal(error.queueName, "provider-sync");
  assert.equal(error.jobName, "weird-job");
  assert.match(error.message, /weird-job/);
  assert.match(error.message, /provider-sync/);
});
