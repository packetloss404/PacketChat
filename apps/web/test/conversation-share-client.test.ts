import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { apiClient } from "../src/lib/api-client";

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

test("share list reads the conversation-scoped endpoint", async () => {
  const calls = mockFetchOnce({ shares: [] });

  await apiClient.conversations.share.list("conversation/1");

  assert.equal(calls[0]?.input, "/api/conversations/conversation%2F1/share");
  assert.equal(calls[0]?.init?.method, undefined);
});

test("share create POSTs and revoke DELETEs the share-scoped endpoint", async () => {
  const createCalls = mockFetchOnce({ share: { id: "share-1" } });
  await apiClient.conversations.share.create("conversation 1");
  assert.equal(createCalls[0]?.input, "/api/conversations/conversation%201/share");
  assert.equal(createCalls[0]?.init?.method, "POST");

  const revokeCalls = mockFetchOnce({ share: { id: "share-1" } });
  await apiClient.conversations.share.revoke("conversation 1", "share/1");
  assert.equal(revokeCalls[0]?.input, "/api/conversations/conversation%201/share/share%2F1");
  assert.equal(revokeCalls[0]?.init?.method, "DELETE");
});
