import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getProviderAdapter, type ProviderAccountRuntime } from "../src/index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function account(provider: ProviderAccountRuntime["provider"]): ProviderAccountRuntime {
  return {
    provider,
    displayName: provider,
    apiKey: "test-key"
  };
}

test("Perplexity validation fails closed on authentication errors", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 });

  const result = await getProviderAdapter("perplexity").test(account("perplexity"));

  assert.equal(result.ok, false);
  assert.match(result.message, /401/);
});

test("Minimax validation only tolerates unsupported model discovery", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 });

  const result = await getProviderAdapter("minimax").test(account("minimax"));

  assert.equal(result.ok, true);
  assert.match(result.message, /not supported/i);
});
