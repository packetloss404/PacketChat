import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PACKET_AGENT_WORKER_MESSAGE_SCHEMA_VERSION,
  packetAgentRunDisplayState,
  packetAgentWorkerMessageSchema,
  resolveRunCardUpsert,
  type PacketAgentRunCard,
  type PacketAgentWorkerMessage
} from "../src/packet-agent";

function fixture(overrides: Partial<PacketAgentWorkerMessage> = {}): PacketAgentWorkerMessage {
  return {
    schemaVersion: PACKET_AGENT_WORKER_MESSAGE_SCHEMA_VERSION,
    thread: { key: "worker-run:run-1", messageKey: "msg-1", behavior: "append" },
    worker: {
      workspaceId: "workspace-1",
      definitionId: "definition-1",
      deploymentId: "deployment-1",
      runId: "run-1",
      versionId: "version-1",
      versionContentDigest: "digest-1"
    },
    state: { deployment: "active", run: "running", version: "version-1", versionNumber: 1, reason: "started" },
    budget: { usage: { steps: 1 }, limits: { steps: 10 } },
    checkpoint: { id: "checkpoint-1", sequence: 1, phase: "plan", iteration: 0, stateDigest: "abc" },
    evidence: { id: "evidence-1", href: "https://evidence.example.test/1" },
    requiredAction: "none",
    title: "Worker run",
    summary: "Working",
    callbacks: { open: "https://agent.example.test/open?sig=1", inspect: "https://agent.example.test/inspect?sig=2" },
    ...overrides
  };
}

function existingCard(): PacketAgentRunCard {
  return {
    connectionId: "connection-1",
    threadKey: "worker-run:run-1",
    workerRunId: "run-1",
    workerDefinitionId: "definition-1",
    workerDeploymentId: "deployment-1",
    workerVersionId: "version-1",
    workerVersionContentDigest: "digest-1",
    title: "Worker run",
    summary: "Working",
    state: { deployment: "active", run: "running", version: "version-1", versionNumber: 1, reason: "started" },
    budget: { usage: { steps: 1 }, limits: { steps: 10 } },
    checkpoint: { id: "checkpoint-1", sequence: 1, phase: "plan", iteration: 0, stateDigest: "abc" },
    requiredAction: "none",
    evidence: { id: "evidence-1", href: "https://evidence.example.test/1" },
    callbacks: { open: "https://agent.example.test/open?sig=1", inspect: "https://agent.example.test/inspect?sig=2" }
  };
}

test("the exact PacketAgent worker message fixture is accepted", () => {
  const parsed = packetAgentWorkerMessageSchema.safeParse(fixture());
  assert.equal(parsed.success, true);
});

test("a wrong schemaVersion is rejected", () => {
  const parsed = packetAgentWorkerMessageSchema.safeParse({ ...fixture(), schemaVersion: "packetagent.packetchat-worker-message/v2" });
  assert.equal(parsed.success, false);
});

test("an unknown thread behavior is rejected", () => {
  const parsed = packetAgentWorkerMessageSchema.safeParse(fixture({ thread: { key: "worker-run:run-1", messageKey: "msg-1", behavior: "merge" as never } }));
  assert.equal(parsed.success, false);
});

test("thread.key must match the worker run id", () => {
  const parsed = packetAgentWorkerMessageSchema.safeParse({ ...fixture(), thread: { key: "worker-run:other", messageKey: "msg-1", behavior: "append" } });
  assert.equal(parsed.success, false);
});

test("checkpoint may be absent and state.reason may be omitted", () => {
  const message = fixture();
  delete (message as { checkpoint?: unknown }).checkpoint;
  message.state = { deployment: "active", run: "running", version: "version-1", versionNumber: 1 };
  const parsed = packetAgentWorkerMessageSchema.safeParse(message);
  assert.equal(parsed.success, true);
});

test("replace always replaces the card and does not append an event", () => {
  const message = fixture({ thread: { key: "worker-run:run-1", messageKey: "run-1", behavior: "replace" } });
  const result = resolveRunCardUpsert(existingCard(), message, ["run-1"]);

  assert.equal(result.eventBehavior, "replace");
  assert.equal(result.isDuplicate, false);
  assert.equal(result.card.summary, "Working");
});

test("append without a prior message key appends an event", () => {
  const result = resolveRunCardUpsert(existingCard(), fixture(), []);
  assert.equal(result.eventBehavior, "append");
  assert.equal(result.isDuplicate, false);
});

test("append with a known message key is ignored as a duplicate", () => {
  const result = resolveRunCardUpsert(existingCard(), fixture(), ["msg-1"]);
  assert.equal(result.eventBehavior, "append-ignore-duplicate");
  assert.equal(result.isDuplicate, true);
});

test("a replace with no checkpoint keeps the last known checkpoint when appending", () => {
  const message = fixture({ checkpoint: undefined, thread: { key: "worker-run:run-1", messageKey: "msg-2", behavior: "append" } });
  const result = resolveRunCardUpsert(existingCard(), message, []);
  assert.equal(result.card.checkpoint?.id, "checkpoint-1");
});

test("display state buckets", () => {
  const card = (patch: Partial<PacketAgentRunCard>) => ({ ...existingCard(), ...patch });

  assert.equal(packetAgentRunDisplayState(card({ state: { ...existingCard().state, run: "running" } })), "progress");
  assert.equal(packetAgentRunDisplayState(card({ requiredAction: "approval" })), "attention");
  assert.equal(packetAgentRunDisplayState(card({ state: { ...existingCard().state, run: "completed" } })), "completed");
  assert.equal(packetAgentRunDisplayState(card({ state: { ...existingCard().state, run: "failed" } })), "failed");
  assert.equal(packetAgentRunDisplayState(card({ state: { ...existingCard().state, run: "cancelled" } })), "cancelled");
  assert.equal(packetAgentRunDisplayState(card({ state: { ...existingCard().state, run: "budget_exceeded" } })), "budget_exceeded");
  assert.equal(
    packetAgentRunDisplayState(card({ budget: { usage: { total: 12 }, limits: { total: 10 } } })),
    "budget_exceeded"
  );
  assert.equal(packetAgentRunDisplayState(card({ state: { ...existingCard().state, run: "mystery" }, requiredAction: "none" })), "unknown");
});
