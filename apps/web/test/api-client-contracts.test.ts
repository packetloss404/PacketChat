import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { apiClient } from "../src/lib/api-client";

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function mockFetchOnce(body: unknown) {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return jsonResponse(body);
  }) as typeof fetch;
  return calls;
}

function firstCall(calls: FetchCall[]) {
  const call = calls[0];
  assert.ok(call, "expected fetch to be called");
  return call;
}

async function jsonBody(call: FetchCall) {
  const body = call.init?.body;
  if (typeof body !== "string") {
    throw new TypeError("expected request body to be a string");
  }
  return JSON.parse(body);
}

test("approval decisions use the approval endpoint and preserve the decision payload", async () => {
  const calls = mockFetchOnce({ approval: { id: "approval-1", status: "cancelled" } });

  const result = await apiClient.approvals.decide("approval/id with spaces", {
    decision: "rejected",
    note: "Needs a safer scope"
  });

  const call = firstCall(calls);
  assert.equal(call.input, "/api/approvals/approval%2Fid%20with%20spaces");
  assert.equal(call.init?.method, "PATCH");
  assert.deepEqual(await jsonBody(call), {
    decision: "rejected",
    note: "Needs a safer scope"
  });
  assert.deepEqual(result.approval, { id: "approval-1", status: "cancelled" });
});

test("admin usage preserves governance totals and recommendations", async () => {
  const calls = mockFetchOnce({
    summary: [],
    recent: [],
    governance: {
      totals: {
        requests: 4,
        costUsd: 1.25,
        unknownCostCount: 1,
        estimatedCount: 2,
        activeUsers: 3,
        projectedMonthCostUsd: 8.75
      },
      byUser: [{ user_email: "admin@example.com", request_count: 3, cost_usd: 1.2, unknown_cost_count: 1 }],
      byProvider: [{ provider: "openai-compatible", request_count: 4, cost_usd: 1.25, unknown_cost_count: 1 }],
      recommendations: ["1 records have unknown pricing; add catalog pricing before using this report for chargeback."]
    }
  });

  const result = await apiClient.admin.usage();

  const call = firstCall(calls);
  assert.equal(call.input, "/api/admin/usage");
  assert.equal(result.governance?.totals.unknownCostCount, 1);
  assert.equal(result.governance?.totals.projectedMonthCostUsd, 8.75);
  assert.deepEqual(result.governance?.byProvider[0], {
    provider: "openai-compatible",
    request_count: 4,
    cost_usd: 1.25,
    unknown_cost_count: 1
  });
  assert.match(result.governance?.recommendations[0] ?? "", /unknown pricing/);
});

test("project list responses keep enriched metadata fields", async () => {
  const calls = mockFetchOnce({
    projects: [{
      id: "project-1",
      name: "Customer launch",
      description: null,
      instructions: "Summarize weekly",
      default_model_preset_id: "preset-1",
      default_model_preset: {
        id: "preset-1",
        name: "Ops default",
        provider: "anthropic",
        model: "claude-sonnet"
      },
      conversation_count: 7,
      last_conversation_at: "2026-05-26T05:00:00.000Z",
      updated_at: "2026-05-26T05:00:00.000Z"
    }]
  });

  const result = await apiClient.projects.list();

  const call = firstCall(calls);
  assert.equal(call.input, "/api/projects");
  assert.equal(result.projects[0]?.default_model_preset?.provider, "anthropic");
  assert.equal(result.projects[0]?.conversation_count, 7);
  assert.equal(result.projects[0]?.last_conversation_at, "2026-05-26T05:00:00.000Z");
});

test("knowledge search posts retrieval options and exposes result source context", async () => {
  const calls = mockFetchOnce({
    query: "packet policy",
    results: [{
      documentId: "document-1",
      chunkId: "chunk-1",
      chunkIndex: 2,
      title: "Policy Notes",
      mimeType: "text/markdown",
      score: 0.92,
      lexicalScore: 4,
      semanticScore: 0.6,
      coverageScore: 1,
      embeddingStatus: "current",
      matchedTerms: ["packet", "policy"],
      source: {
        name: "policy.md",
        fileName: "policy.md",
        detectedType: "markdown",
        attachmentId: "attachment-1",
        sizeBytes: 1200,
        createdAt: "2026-05-20T05:00:00.000Z",
        updatedAt: "2026-05-26T05:00:00.000Z",
        metadata: { fileName: "policy.md" }
      },
      freshness: {
        updatedAt: "2026-05-26T05:00:00.000Z",
        chunkCreatedAt: "2026-05-26T05:01:00.000Z",
        embeddingStatus: "current",
        embeddingVersion: "packetchat-local-hash-v2",
        embeddingCreatedAt: "2026-05-26T05:01:00.000Z",
        embeddingRefreshedAt: null,
        ageDays: 0,
        label: "updated today"
      },
      explanation: "Citation Policy Notes#chunk-2 | Matched 2/2 query terms: packet, policy",
      snippet: "Packet policy details",
      citation: "Policy Notes#chunk-2"
    }],
    pagination: { limit: 2, offset: 1, total: 3, hasMore: false, candidateLimit: 25 },
    embeddings: { fallback: false, missing: 0, outdated: 0, invalid: 0 }
  });

  const result = await apiClient.knowledge.search("kb/id with spaces", {
    query: "packet policy",
    limit: 2,
    offset: 1,
    candidateLimit: 25
  });

  const call = firstCall(calls);
  assert.equal(call.input, "/api/knowledge/kb%2Fid%20with%20spaces/search");
  assert.equal(call.init?.method, "POST");
  assert.deepEqual(await jsonBody(call), {
    query: "packet policy",
    limit: 2,
    offset: 1,
    candidateLimit: 25
  });
  assert.deepEqual(result.results[0]?.matchedTerms, ["packet", "policy"]);
  assert.equal(result.results[0]?.source?.detectedType, "markdown");
  assert.equal(result.results[0]?.freshness?.label, "updated today");
  assert.match(result.results[0]?.explanation ?? "", /Matched 2\/2/);
});
