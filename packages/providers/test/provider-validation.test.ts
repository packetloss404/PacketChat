import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getProviderAdapter, validateProviderBaseUrl, type ProviderAccountRuntime } from "../src/index";

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

test("provider base URL validation blocks private non-local targets", () => {
  const result = validateProviderBaseUrl("anthropic", "https://192.168.1.10:8080");

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "provider_base_url_private_blocked");
});

test("provider base URL validation allows local OpenAI-compatible endpoints", () => {
  const result = validateProviderBaseUrl("openai-compatible", "http://localhost:11434");

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.local, true);
    assert.equal(result.value, "http://localhost:11434");
  }
});

test("provider base URL validation rejects local endpoints for hosted providers", () => {
  const result = validateProviderBaseUrl("perplexity", "http://localhost:1234");

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "provider_base_url_local_blocked");
});

test("provider base URL validation rejects embedded credentials", () => {
  const result = validateProviderBaseUrl("openai-compatible", "https://token@example.com");

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "provider_base_url_credentials_blocked");
});

test("Anthropic model discovery uses runtime base URL safety checks", async () => {
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };

  await assert.rejects(
    () => getProviderAdapter("anthropic").listModels({ ...account("anthropic"), baseUrl: "https://192.168.1.10:8080" }),
    (error: unknown) => {
      assert.equal(error instanceof Error ? error.name : "", "ProviderFetchError");
      assert.equal((error as { code?: string }).code, "provider_base_url_private_blocked");
      return true;
    }
  );
  assert.equal(fetchCalled, false);
});

test("OpenAI-compatible streams surface provider error chunks", async () => {
  globalThis.fetch = async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"error":{"code":"bad_request","message":"boom"}}\n\n'));
        controller.close();
      }
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );

  const events = [];
  for await (const event of getProviderAdapter("openai-compatible").streamChat(account("openai-compatible"), {
    provider: "openai-compatible",
    model: "test-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    stream: true
  })) {
    events.push(event);
  }

  assert.equal(events[0]?.type, "message_start");
  assert.equal(events[1]?.type, "error");
  assert.equal(events[1]?.type === "error" ? events[1].error.code : "", "bad_request");
});

test("OpenAI-compatible local /v1 base URLs are not doubled", async () => {
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        }
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  };

  const localAccount = { ...account("openai-compatible"), baseUrl: "http://localhost:1234/v1" };
  for await (const _event of getProviderAdapter("openai-compatible").streamChat(localAccount, {
    provider: "openai-compatible",
    model: "test-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    stream: true
  })) {
    // Drain the stream.
  }

  assert.equal(requestedUrl, "http://localhost:1234/v1/chat/completions");
});
