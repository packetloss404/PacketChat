import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

// The outbound client encrypts in-memory credentials through @packetchat/auth,
// which reads the app config on first use. The ingest path needs no config, but
// the Agent client does, so a minimal development config is supplied here.
process.env.DATABASE_URL ??= "postgres://localhost:5432/packetchat_test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.S3_ENDPOINT ??= "http://localhost:9000";
process.env.S3_ACCESS_KEY ??= "test-access";
process.env.S3_SECRET_KEY ??= "test-secret";
process.env.S3_BUCKET_UPLOADS ??= "uploads";
process.env.S3_BUCKET_EXPORTS ??= "exports";
process.env.S3_BUCKET_ARTIFACTS ??= "artifacts";
process.env.BOOTSTRAP_TOKEN ??= "test-bootstrap-token-value";
process.env.JWT_SECRET ??= "test-jwt-secret-that-is-long-enough";
process.env.ENCRYPTION_KEY_BASE64 ??= Buffer.alloc(32, 7).toString("base64");

import { encryptJsonSecret } from "@packetchat/auth";
import { apiClient } from "../src/lib/api-client";
import { callPacketAgent, interpretInspectResponse, interpretOpenResponse } from "../src/lib/packet-agent";

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchOnce(body: unknown, status = 200) {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

test("the Agent token is sent only to the Agent, alongside the workspace header", async () => {
  const calls = mockFetchOnce({ deployment: { revision: 4 } });
  const agentCredentials = encryptJsonSecret({ token: "agent-token-xyz", workspaceId: "workspace-1" });

  await callPacketAgent(
    { agentBaseUrl: "https://agent.example.test", workspaceId: "workspace-1", agentCredentials },
    "/api/worker-deployments/dep-1"
  );

  const call = calls[0];
  assert.ok(call);
  assert.equal(call.input, "https://agent.example.test/api/worker-deployments/dep-1");
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer agent-token-xyz");
  assert.equal(headers.get("PacketAgent-Workspace-Id"), "workspace-1");
});

test("connection create POSTs the body and never receives credentials back", async () => {
  const calls = mockFetchOnce({
    connection: { id: "connection-1", projectId: "project/1", name: "Prod", workspaceId: "ws-1" },
    ingestToken: { token: "pchat_connection-1.secret", prefix: "secret12" },
    endpointUrl: "https://chat.example.test/api/packet-agent/worker-notifications",
    routeConfig: { schemaVersion: "packetagent.packetchat-route/v1" }
  });

  const result = await apiClient.packetAgent.connections.create("project/1", {
    name: "Prod",
    workspaceId: "ws-1",
    agentBaseUrl: "https://agent.example.test",
    agentToken: "agent-token"
  });

  const call = calls[0];
  assert.ok(call);
  assert.equal(call.input, "/api/projects/project%2F1/packet-agent/connections");
  assert.equal(call.init?.method, "POST");
  assert.equal(JSON.parse(String(call.init?.body)).agentToken, "agent-token");
  assert.equal((result.connection as Record<string, unknown>).agentToken, undefined);
  assert.equal((result.connection as Record<string, unknown>).agentCredentials, undefined);
});

test("run list, start, and inspect target the project-scoped endpoints", async () => {
  const listCalls = mockFetchOnce({ runs: [{ id: "run-1", displayState: "progress", title: "Working" }] });
  const list = await apiClient.packetAgent.runs.list("project/1");
  assert.equal(listCalls[0]?.input, "/api/projects/project%2F1/packet-agent/runs");
  assert.equal("callbacks" in (list.runs[0] as Record<string, unknown>), false);

  const startCalls = mockFetchOnce({ ok: true, connectionId: "connection-1", deploymentId: "dep-1", revision: 3, result: {} });
  await apiClient.packetAgent.runs.start("project/1", { connectionId: "connection-1", deploymentId: "dep-1", input: { text: "go" } });
  assert.equal(startCalls[0]?.input, "/api/projects/project%2F1/packet-agent/runs");
  assert.equal(startCalls[0]?.init?.method, "POST");

  const inspectCalls = mockFetchOnce({ ok: false, expired: true, message: "expired" });
  const inspected = await apiClient.packetAgent.runs.inspect("project/1", "run/1");
  assert.equal(inspectCalls[0]?.input, "/api/projects/project%2F1/packet-agent/runs/run%2F1/inspect");
  assert.deepEqual(inspected, { ok: false, expired: true, message: "expired" });
});

test("open proxies the signed callback server-side and returns only the Agent URL", async () => {
  const calls = mockFetchOnce({ ok: true, expired: false, url: "https://agent.example.test/runs/worker/run-1" });
  const result = await apiClient.packetAgent.runs.open("project/1", "run/1");
  assert.equal(calls[0]?.input, "/api/projects/project%2F1/packet-agent/runs/run%2F1/open");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.url, "https://agent.example.test/runs/worker/run-1");
});

test("open maps an Agent 401/410 to expired and rejects a non-http URL", () => {
  const expired = interpretOpenResponse(401, null);
  assert.equal(expired.ok, false);
  assert.equal(expired.expired, true);
  if (!expired.ok && expired.expired) assert.match(expired.message, /expired/i);

  const ok = interpretOpenResponse(200, { action: "open", openUrl: "https://agent.example.test/runs/worker/run-1" });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.url, "https://agent.example.test/runs/worker/run-1");

  const bad = interpretOpenResponse(200, { action: "open", openUrl: "javascript:alert(1)" });
  assert.equal(bad.ok, false);
  if (!bad.ok && !bad.expired) assert.match(bad.error, /open URL/i);
});

test("inspect maps an Agent 401/410 to expired and strips credentials from detail", () => {
  const expired = interpretInspectResponse(401, null);
  assert.equal(expired.ok, false);
  assert.equal(expired.expired, true);
  if (!expired.ok && expired.expired) assert.match(expired.message, /expired/i);
  assert.equal(interpretInspectResponse(410, null).expired, true);

  const ok = interpretInspectResponse(200, { id: "evidence-1", token: "should-be-stripped", nested: { secret: "nope", value: 1 } });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    const detail = ok.detail as Record<string, unknown>;
    assert.equal("token" in detail, false);
    assert.deepEqual(detail.nested, { value: 1 });
  }
});
