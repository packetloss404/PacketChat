#!/usr/bin/env node

const providers = [
  {
    id: "openai-compatible",
    keyEnv: "OPENAI_COMPATIBLE_API_KEY",
    modelEnv: "OPENAI_COMPATIBLE_MODEL",
    baseUrl: env("OPENAI_COMPATIBLE_BASE_URL", "https://api.openai.com"),
    modelsPath: "/v1/models",
    chatPath: "/v1/chat/completions",
    authHeaders: (key) => ({ authorization: `Bearer ${key}` }),
    defaultModel: "gpt-4o-mini"
  },
  {
    id: "azure-openai",
    keyEnv: "AZURE_OPENAI_API_KEY",
    modelEnv: "AZURE_OPENAI_DEPLOYMENT",
    baseUrl: env("AZURE_OPENAI_BASE_URL", ""),
    apiVersion: env("AZURE_OPENAI_API_VERSION", "2024-10-21"),
    authHeaders: (key) => ({ "api-key": key })
  },
  {
    id: "anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    modelEnv: "ANTHROPIC_MODEL",
    baseUrl: env("ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
    modelsPath: "/v1/models",
    authHeaders: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    defaultModel: "claude-3-5-haiku-latest"
  },
  {
    id: "perplexity",
    keyEnv: "PERPLEXITY_API_KEY",
    modelEnv: "PERPLEXITY_MODEL",
    baseUrl: env("PERPLEXITY_BASE_URL", "https://api.perplexity.ai"),
    modelsPath: "/v1/models",
    chatPath: "/v1/chat/completions",
    authHeaders: (key) => ({ authorization: `Bearer ${key}` }),
    defaultModel: "sonar"
  },
  {
    id: "minimax",
    keyEnv: "MINIMAX_API_KEY",
    modelEnv: "MINIMAX_MODEL",
    baseUrl: env("MINIMAX_BASE_URL", "https://api.minimax.io"),
    modelsPath: "/v1/models",
    chatPath: "/v1/chat/completions",
    authHeaders: (key) => ({ authorization: `Bearer ${key}` }),
    defaultModel: "MiniMax-Text-01"
  }
];

function env(name, fallback) {
  return process.env[name] || fallback;
}

function asBaseUrl(url) {
  return url.replace(/\/$/, "");
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers });
  const body = await readJson(response);
  return { ok: response.ok, status: response.status, body };
}

function normalizeOpenAiUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const completionDetails = raw.completion_tokens_details && typeof raw.completion_tokens_details === "object" ? raw.completion_tokens_details : {};
  const normalized = {
    inputTokens: raw.prompt_tokens ?? raw.input_tokens,
    outputTokens: raw.completion_tokens ?? raw.output_tokens,
    reasoningTokens: completionDetails.reasoning_tokens ?? raw.reasoning_tokens,
    searchQueries: raw.num_search_queries ?? raw.search_queries
  };
  return Object.values(normalized).some((value) => typeof value === "number") ? normalized : null;
}

function normalizeAnthropicUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const normalized = { inputTokens: raw.input_tokens, outputTokens: raw.output_tokens };
  return Object.values(normalized).some((value) => typeof value === "number") ? normalized : null;
}

function mergeUsage(current, next) {
  if (!next) return current;
  return { ...current, ...Object.fromEntries(Object.entries(next).filter(([, value]) => typeof value === "number")) };
}

async function readSseUsage(response, providerId) {
  if (!response.body) return { text: "", usage: null, finishReason: null };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage = null;
  let finishReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data);
      if (providerId === "anthropic") {
        usage = mergeUsage(usage, normalizeAnthropicUsage(event.message?.usage));
        usage = mergeUsage(usage, normalizeAnthropicUsage(event.usage));
        if (event.type === "content_block_delta" && event.delta?.text) text += event.delta.text;
        finishReason = event.delta?.stop_reason ?? finishReason;
      } else {
        usage = mergeUsage(usage, normalizeOpenAiUsage(event.usage));
        text += event.choices?.[0]?.delta?.content ?? "";
        finishReason = event.choices?.[0]?.finish_reason ?? finishReason;
      }
    }
  }

  return { text, usage, finishReason };
}

function openAiChatBody(provider, model) {
  const body = {
    model,
    messages: [{ role: "user", content: "Reply with the word ok." }],
    max_tokens: 8,
    temperature: 0,
    stream: true
  };
  if (provider.id !== "minimax") body.stream_options = { include_usage: true };
  return body;
}

function anthropicChatBody(model) {
  return {
    model,
    max_tokens: 8,
    temperature: 0,
    messages: [{ role: "user", content: "Reply with the word ok." }],
    stream: true
  };
}

async function testProvider(provider) {
  const key = process.env[provider.keyEnv];
  const model = process.env[provider.modelEnv] || provider.defaultModel;
  if (!key) return { id: provider.id, status: "skipped", reason: `${provider.keyEnv} is not set` };
  if (!provider.baseUrl) return { id: provider.id, status: "skipped", reason: "base URL is required" };
  if (!model) return { id: provider.id, status: "skipped", reason: `${provider.modelEnv} is not set` };

  const baseUrl = asBaseUrl(provider.baseUrl);
  const headers = { "content-type": "application/json", ...provider.authHeaders(key) };
  let models = null;
  if (provider.id === "azure-openai") {
    models = await fetchJson(`${baseUrl}/openai/deployments?api-version=${provider.apiVersion}`, headers);
  } else if (provider.modelsPath) {
    models = await fetchJson(`${baseUrl}${provider.modelsPath}`, headers);
  }

  const chatUrl = provider.id === "azure-openai"
    ? `${baseUrl}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${provider.apiVersion}`
    : `${baseUrl}${provider.id === "anthropic" ? "/v1/messages" : provider.chatPath}`;
  const chatBody = provider.id === "anthropic" ? anthropicChatBody(model) : openAiChatBody(provider, model);
  if (provider.id === "azure-openai") delete chatBody.model;

  const chat = await fetch(chatUrl, { method: "POST", headers, body: JSON.stringify(chatBody) });
  if (!chat.ok) return { id: provider.id, status: "failed", modelsStatus: models?.status ?? null, chatStatus: chat.status, error: await readJson(chat) };
  const streamed = await readSseUsage(chat, provider.id);
  return {
    id: provider.id,
    status: "ok",
    model,
    modelsStatus: models?.status ?? null,
    chatStatus: chat.status,
    textReceived: streamed.text.length > 0,
    finishReason: streamed.finishReason,
    usageReceived: Boolean(streamed.usage),
    usage: streamed.usage
  };
}

const results = [];
for (const provider of providers) {
  try {
    results.push(await testProvider(provider));
  } catch (error) {
    results.push({ id: provider.id, status: "failed", error: error instanceof Error ? error.message : String(error) });
  }
}

for (const result of results) {
  const suffix = result.reason ? ` (${result.reason})` : "";
  console.log(`${result.id}: ${result.status}${suffix}`);
  if (result.status !== "skipped") console.log(JSON.stringify(result, null, 2));
}

if (results.some((result) => result.status === "failed")) process.exitCode = 1;
