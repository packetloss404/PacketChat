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

function chatRequest(provider: ProviderAccountRuntime["provider"]) {
  return {
    provider,
    model: "test-model",
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }],
    stream: true
  };
}

test("named providers discover models from their own current catalogs", async () => {
  const cases = [
    { provider: "openai" as const, url: "https://api.openai.com/v1/models", body: { data: [{ id: "gpt-new" }] }, expected: "gpt-new" },
    { provider: "xai" as const, url: "https://api.x.ai/v1/language-models", body: { models: [{ id: "grok-new" }] }, expected: "grok-new" },
    { provider: "sugar" as const, url: "https://usesugar.dev/api/v1/models", body: { data: [{ id: "sugar/conduit" }] }, expected: "sugar/conduit" },
    { provider: "opencode-go" as const, url: "https://opencode.ai/zen/go/v1/models", body: { data: [{ id: "kimi-new" }] }, expected: "kimi-new" },
    { provider: "ollama-cloud" as const, url: "https://ollama.com/api/tags", body: { models: [{ name: "gemma-new:31b" }] }, expected: "gemma-new:31b" },
    { provider: "cline-pass" as const, url: "https://api.cline.bot/api/v1/ai/cline/recommended-models", body: { recommended: [{ id: "openai/not-on-pass" }], clinePass: [{ id: "cline-pass/kimi-new", name: "Kimi New" }] }, expected: "cline-pass/kimi-new" }
  ];
  for (const item of cases) {
    let requestedUrl = "";
    globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify(item.body), { status: 200 });
    };
    const models = await getProviderAdapter(item.provider).listModels(account(item.provider));
    assert.equal(requestedUrl, item.url);
    assert.deepEqual(models.map((model) => model.id), [item.expected]);
  }
});

test("Anthropic and Google follow model catalog pagination", async () => {
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("api.anthropic.com")) {
      return new Response(JSON.stringify(url.includes("after_id")
        ? { data: [{ id: "claude-next", display_name: "Claude Next" }], has_more: false }
        : { data: [{ id: "claude-first" }], has_more: true, last_id: "claude-first" }));
    }
    return new Response(JSON.stringify(url.includes("pageToken")
      ? { models: [{ name: "models/gemini-next", supportedGenerationMethods: ["generateContent"] }] }
      : { models: [{ name: "models/gemini-first", supportedGenerationMethods: ["generateContent"] }, { name: "models/embed-only", supportedGenerationMethods: ["embedContent"] }], nextPageToken: "page-2" }));
  };
  assert.deepEqual((await getProviderAdapter("anthropic").listModels(account("anthropic"))).map((model) => model.id), ["claude-first", "claude-next"]);
  assert.deepEqual((await getProviderAdapter("google").listModels(account("google"))).map((model) => model.id), ["gemini-first", "gemini-next"]);
  assert.equal(urls.length, 4);
});

test("direct OpenAI Responses and Google Gemini streams return text and usage", async () => {
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("generativelanguage")) {
      assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "test-key");
      return new Response('data: {"candidates":[{"content":{"parts":[{"text":"Gemini says hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4}}\n\n');
    }
    assert.equal(String(input), "https://api.openai.com/v1/responses");
    return new Response('data: {"type":"response.output_text.delta","delta":"OpenAI says hi"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":3}}}\n\n');
  };
  const openAiEvents = [];
  for await (const event of getProviderAdapter("openai").streamChat(account("openai"), chatRequest("openai"))) openAiEvents.push(event);
  assert.deepEqual(openAiEvents.map((event) => event.type), ["message_start", "text_delta", "message_end"]);
  assert.equal(openAiEvents[2]?.type === "message_end" ? openAiEvents[2].usage?.outputTokens : null, 3);

  const googleEvents = [];
  for await (const event of getProviderAdapter("google").streamChat(account("google"), chatRequest("google"))) googleEvents.push(event);
  assert.deepEqual(googleEvents.map((event) => event.type), ["message_start", "text_delta", "message_end"]);
  assert.equal(googleEvents[2]?.type === "message_end" ? googleEvents[2].usage?.inputTokens : null, 3);
});

test("direct xAI Responses and Anthropic Messages streams use their native endpoints", async () => {
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("api.x.ai")) {
      assert.equal(String(input), "https://api.x.ai/v1/responses");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
      return new Response('data: {"type":"response.output_text.delta","delta":"Grok"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":2}}}\n\n');
    }
    assert.equal(String(input), "https://api.anthropic.com/v1/messages");
    assert.equal(new Headers(init?.headers).get("x-api-key"), "test-key");
    return new Response('data: {"type":"content_block_delta","delta":{"text":"Claude"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\ndata: {"type":"message_stop"}\n\n');
  };
  const xAiEvents = [];
  for await (const event of getProviderAdapter("xai").streamChat(account("xai"), chatRequest("xai"))) xAiEvents.push(event);
  assert.deepEqual(xAiEvents.map((event) => event.type), ["message_start", "text_delta", "message_end"]);
  const anthropicEvents = [];
  for await (const event of getProviderAdapter("anthropic").streamChat(account("anthropic"), chatRequest("anthropic"))) anthropicEvents.push(event);
  assert.deepEqual(anthropicEvents.map((event) => event.type), ["message_start", "text_delta", "message_end"]);
});

test("OpenCode Go falls through to Responses for a model outside Chat Completions", async () => {
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    if (urls.length === 1) return new Response("{}", { status: 404 });
    return new Response('data: {"type":"response.output_text.delta","delta":"hello"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
  };
  const events = [];
  for await (const event of getProviderAdapter("opencode-go").streamChat(account("opencode-go"), chatRequest("opencode-go"))) events.push(event);
  assert.deepEqual(urls, ["https://opencode.ai/zen/go/v1/chat/completions", "https://opencode.ai/zen/go/v1/responses"]);
  assert.deepEqual(events.map((event) => event.type), ["message_start", "text_delta", "message_end"]);
});

test("OpenCode Go reaches Anthropic-style models with one stable session", async () => {
  const urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    urls.push(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-opencode-session"), "conversation-1");
    assert.equal(headers.get("user-agent"), "PacketChat/0.1");
    if (urls.length < 3) return new Response("{}", { status: 404 });
    assert.equal(headers.get("x-api-key"), "test-key");
    return new Response('data: {"type":"content_block_delta","delta":{"text":"hello"}}\n\ndata: {"type":"message_stop"}\n\n');
  };
  const events = [];
  for await (const event of getProviderAdapter("opencode-go").streamChat(account("opencode-go"), chatRequest("opencode-go"), { sessionId: "conversation-1" })) events.push(event);
  assert.equal(urls[2], "https://opencode.ai/zen/go/v1/messages");
  assert.deepEqual(events.map((event) => event.type), ["message_start", "text_delta", "message_end"]);
});
