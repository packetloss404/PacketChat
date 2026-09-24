import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createIngestToken,
  digestIngestToken,
  handleWorkerNotification,
  type PacketAgentConnectionIdentity,
  type PacketAgentIngestRepo,
  type PacketAgentStoredRun,
  type PacketAgentUpsertInput
} from "../src/lib/packet-agent";
import {
  PACKET_AGENT_WORKER_MESSAGE_SCHEMA_VERSION,
  type PacketAgentWorkerMessage
} from "@packetchat/contracts";

type StoredEvent = {
  messageKey: string;
  idempotencyKey: string;
  event: string;
  payload: Record<string, unknown>;
};

type MemoryRun = PacketAgentStoredRun & {
  projectId: string;
  ownerUserId: string;
  workspaceId: string;
};

class MemoryRepo implements PacketAgentIngestRepo {
  connections = new Map<string, PacketAgentConnectionIdentity>();
  runs = new Map<string, MemoryRun>();
  events = new Map<string, StoredEvent[]>();
  private eventKeys = new Set<string>();
  private idempotencyKeys = new Set<string>();

  addConnection(connection: PacketAgentConnectionIdentity) {
    this.connections.set(connection.id, connection);
  }

  async findConnectionById(connectionId: string) {
    return this.connections.get(connectionId) ?? null;
  }

  async findRunByWorkerRunId(connectionId: string, workerRunId: string) {
    return this.runs.get(`${connectionId}:${workerRunId}`) ?? null;
  }

  async eventExists(connectionId: string, messageKey: string, idempotencyKey: string) {
    return (
      this.eventKeys.has(`${connectionId}:${messageKey}`) ||
      this.idempotencyKeys.has(`${connectionId}:${idempotencyKey}`)
    );
  }

  async applyUpsert(input: PacketAgentUpsertInput) {
    const key = `${input.connectionId}:${input.card.workerRunId}`;
    const existing = this.runs.get(key);
    if (existing) {
      existing.card = input.card;
    } else {
      this.runs.set(key, {
        runId: `row-${input.card.workerRunId}`,
        card: input.card,
        projectId: input.projectId,
        ownerUserId: input.ownerUserId,
        workspaceId: input.workspaceId
      });
    }
    const messageSeen = this.eventKeys.has(`${input.connectionId}:${input.messageKey}`);
    const deliverySeen = this.idempotencyKeys.has(`${input.connectionId}:${input.idempotencyKey}`);
    if (input.appendEvent && !messageSeen && !deliverySeen) {
      this.eventKeys.add(`${input.connectionId}:${input.messageKey}`);
      this.idempotencyKeys.add(`${input.connectionId}:${input.idempotencyKey}`);
      const list = this.events.get(key) ?? [];
      list.push({
        messageKey: input.messageKey,
        idempotencyKey: input.idempotencyKey,
        event: input.event,
        payload: input.eventPayload
      });
      this.events.set(key, list);
    }
    return { runId: this.runs.get(key)!.runId };
  }
}

function makeDeps(repo: MemoryRepo) {
  return { repo, rateLimit: async () => null };
}

function connection(overrides: Partial<PacketAgentConnectionIdentity> = {}): PacketAgentConnectionIdentity {
  return {
    id: "connection-a",
    projectId: "project-a",
    ownerUserId: "owner-a",
    workspaceId: "workspace-a",
    deploymentId: "deployment-a",
    ingestTokenDigest: "unset",
    ...overrides
  };
}

function message(overrides: Partial<PacketAgentWorkerMessage> = {}): PacketAgentWorkerMessage {
  return {
    schemaVersion: PACKET_AGENT_WORKER_MESSAGE_SCHEMA_VERSION,
    thread: { key: "worker-run:run-1", messageKey: "msg-1", behavior: "append" },
    worker: {
      workspaceId: "workspace-a",
      definitionId: "definition-a",
      deploymentId: "deployment-a",
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

function request(token: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://chat.example.test/api/packet-agent/worker-notifications", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

function seededRepo() {
  const repo = new MemoryRepo();
  const ingest = createIngestToken("connection-a");
  repo.addConnection({ ...connection(), ingestTokenDigest: ingest.digest });
  return { repo, token: ingest.token };
}

test("a valid ingest token is accepted and the run maps to the connection's project and owner", async () => {
  const { repo, token } = seededRepo();

  const response = await handleWorkerNotification(request(token, message()), makeDeps(repo));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, runId: "row-run-1" });
  assert.ok(response.headers.get("x-request-id"));
  assert.equal(response.headers.get("cache-control"), "no-store");

  const run = repo.runs.get("connection-a:run-1");
  assert.ok(run);
  assert.equal(run.projectId, "project-a");
  assert.equal(run.ownerUserId, "owner-a");
  assert.equal(run.workspaceId, "workspace-a");
});

test("a missing or invalid token is rejected with 401", async () => {
  const { repo } = seededRepo();

  const missing = await handleWorkerNotification(new Request("https://chat.example.test/x", { method: "POST" }), makeDeps(repo));
  assert.equal(missing.status, 401);

  const wrong = await handleWorkerNotification(request("pchat_connection-a.wrong-secret", message()), makeDeps(repo));
  assert.equal(wrong.status, 401);
});

test("a rotated token is rejected and the new one is accepted", async () => {
  const { repo, token } = seededRepo();
  const rotated = createIngestToken("connection-a");
  repo.connections.set("connection-a", { ...connection(), ingestTokenDigest: rotated.digest });

  const old = await handleWorkerNotification(request(token, message()), makeDeps(repo));
  assert.equal(old.status, 401);

  const next = await handleWorkerNotification(request(rotated.token, message()), makeDeps(repo));
  assert.equal(next.status, 200);
});

test("a worker workspace that does not match the connection is rejected 403", async () => {
  const { repo, token } = seededRepo();

  const response = await handleWorkerNotification(
    request(token, message({ worker: { ...message().worker, workspaceId: "workspace-b" } })),
    makeDeps(repo)
  );
  assert.equal(response.status, 403);
  assert.equal(repo.runs.size, 0);
});

test("a redelivered message key or idempotency key is idempotent and adds no second event", async () => {
  const { repo, token } = seededRepo();
  const deps = makeDeps(repo);

  const first = await handleWorkerNotification(request(token, message(), { "idempotency-key": "delivery-1" }), deps);
  // Same delivery key, new message key: a retry whose message id advanced must not double the thread.
  const retry = await handleWorkerNotification(
    request(token, message({ thread: { key: "worker-run:run-1", messageKey: "msg-2", behavior: "append" } }), { "idempotency-key": "delivery-1" }),
    deps
  );
  // Same message key, new delivery key: a replayed notification must not double the thread either.
  const replay = await handleWorkerNotification(
    request(token, message(), { "idempotency-key": "delivery-2" }),
    deps
  );

  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(repo.events.get("connection-a:run-1")?.length, 1);
});

test("replace updates the card without creating an event while append adds one", async () => {
  const { repo, token } = seededRepo();
  const deps = makeDeps(repo);

  await handleWorkerNotification(
    request(token, message({ thread: { key: "worker-run:run-1", messageKey: "msg-1", behavior: "append" } })),
    deps
  );
  assert.equal(repo.events.get("connection-a:run-1")?.length, 1);

  await handleWorkerNotification(
    request(
      token,
      message({
        thread: { key: "worker-run:run-1", messageKey: "run-1", behavior: "replace" },
        summary: "Replaced summary",
        requiredAction: "approval"
      })
    ),
    deps
  );

  assert.equal(repo.events.get("connection-a:run-1")?.length, 1, "replace must not append an event");
  assert.equal(repo.runs.get("connection-a:run-1")?.card.summary, "Replaced summary");
  assert.equal(repo.runs.get("connection-a:run-1")?.card.requiredAction, "approval");
});

test("a restart replaying persisted rows through a fresh handler stays idempotent", async () => {
  const { repo, token } = seededRepo();
  const body = message();

  await handleWorkerNotification(request(token, body, { "idempotency-key": "delivery-1" }), makeDeps(repo));
  // A fresh handler instance over the same persisted rows is what a redeploy looks like.
  const replayed = await handleWorkerNotification(request(token, body, { "idempotency-key": "delivery-1" }), makeDeps(repo));

  assert.equal(replayed.status, 200);
  assert.equal(repo.events.get("connection-a:run-1")?.length, 1);
});

test("a message for project A's workspace cannot appear under project B", async () => {
  const repo = new MemoryRepo();
  const tokenA = createIngestToken("connection-a");
  const tokenB = createIngestToken("connection-b");
  repo.addConnection({ ...connection(), ingestTokenDigest: tokenA.digest });
  repo.addConnection({
    ...connection({ id: "connection-b", projectId: "project-b", ownerUserId: "owner-b", workspaceId: "workspace-b", ingestTokenDigest: tokenB.digest })
  });

  const rejected = await handleWorkerNotification(request(tokenB.token, message()), makeDeps(repo));
  assert.equal(rejected.status, 403);
  assert.equal(repo.runs.size, 0);

  const accepted = await handleWorkerNotification(request(tokenA.token, message()), makeDeps(repo));
  assert.equal(accepted.status, 200);
  assert.equal(repo.runs.get("connection-a:run-1")?.projectId, "project-a");
  assert.equal(repo.runs.has("connection-b:run-1"), false);
});

test("a malformed body is rejected 400 without writing", async () => {
  const { repo, token } = seededRepo();
  const response = await handleWorkerNotification(request(token, { schemaVersion: "nope" }), makeDeps(repo));
  assert.equal(response.status, 400);
  assert.equal(repo.runs.size, 0);
});

test("the stored event payload never includes the callbacks", async () => {
  const { repo, token } = seededRepo();
  await handleWorkerNotification(request(token, message()), makeDeps(repo));

  const event = repo.events.get("connection-a:run-1")?.[0];
  assert.ok(event);
  assert.equal("callbacks" in event.payload, false);
});
