import assert from "node:assert/strict";
import { test } from "node:test";
import { queueNames } from "../src/index";
import { KNOWN_QUEUE_NAMES, assertKnownQueue, isKnownQueue, jobNames } from "../src/queues";

test("isKnownQueue is true for every configured queue name", () => {
  for (const name of Object.values(queueNames)) {
    assert.equal(isKnownQueue(name), true);
  }
});

test("isKnownQueue is false for an unknown queue name", () => {
  assert.equal(isKnownQueue("bogus"), false);
});

test("assertKnownQueue throws on unknown queue and is silent on known", () => {
  assert.throws(() => assertKnownQueue("bogus"), /Unknown queue: bogus/);
  for (const name of Object.values(queueNames)) {
    assert.doesNotThrow(() => assertKnownQueue(name));
  }
});

test("KNOWN_QUEUE_NAMES contains the four queue names", () => {
  assert.equal(KNOWN_QUEUE_NAMES.length, 4);
  assert.deepEqual(
    [...KNOWN_QUEUE_NAMES].sort(),
    [queueNames.providerSync, queueNames.fileIngestion, queueNames.agentRun, queueNames.cleanup].sort()
  );
});

test("jobNames exposes the three enqueue job identifiers", () => {
  assert.equal(jobNames.providerSync, "sync-provider");
  assert.equal(jobNames.agentRun, "run-agent");
  assert.equal(jobNames.cleanup, "run-cleanup");
});
