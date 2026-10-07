import type { NormalizedChatRequest, NormalizedUsage, ProviderId, StreamEvent } from "@packetchat/contracts";
import { randomUUID } from "node:crypto";
import {
  fetchWithTimeout,
  isUnsupportedModelDiscovery,
  MODEL_LIST_TIMEOUT_MS,
  providerBaseUrlForRequest,
  providerDisplayName,
  ProviderFetchError,
  readWithTimeout,
  STREAM_CONNECT_TIMEOUT_MS,
  STREAM_READ_TIMEOUT_MS,
  streamErrorEvent,
  testFailureResult
} from "./provider-http";

export type ProviderAccountRuntime = {
  provider: ProviderId;
  displayName: string;
  baseUrl?: string | null;
  apiVersion?: string | null;
  region?: string | null;
  apiKey: string;
  providerHints?: Record<string, unknown>;
};

export type ProviderModelSnapshot = {
  id: string;
  displayName: string;
  raw?: unknown;
};

export type ProviderTestResult = {
  ok: boolean;
  message: string;
  models?: ProviderModelSnapshot[];
};

export interface ProviderAdapter {
  id: ProviderId;
  defaultBaseUrl: string;
  test(account: ProviderAccountRuntime): Promise<ProviderTestResult>;
  listModels(account: ProviderAccountRuntime): Promise<ProviderModelSnapshot[]>;
  streamChat(account: ProviderAccountRuntime, request: NormalizedChatRequest, options?: StreamChatOptions): AsyncIterable<StreamEvent>;
}

export type StreamChatOptions = {
  signal?: AbortSignal;
  sessionId?: string;
};

function jsonHeaders(apiKey: string, extra: Record<string, string> = {}) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    ...extra
  };
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function modelSnapshotsFromOpenAIList(raw: unknown): ProviderModelSnapshot[] {
  return namedSnapshots(modelArray(raw, "data"), "id", "id");
}

function responseError(providerName: string, status: number) {
  return new ProviderFetchError({
    code: "provider_request_failed",
    message: publicProviderError(providerName, status),
    retryable: status >= 500 || status === 429,
    status
  });
}

async function modelListJson(account: ProviderAccountRuntime, path: string, headers: Record<string, string>, providerName = providerDisplayName(account.provider)) {
  const baseUrl = await providerBaseUrlForRequest(account.provider, adapters[account.provider].defaultBaseUrl, account.baseUrl);
  const response = await fetchWithTimeout(openAiStyleEndpoint(baseUrl, path), { headers }, MODEL_LIST_TIMEOUT_MS, providerName);
  const raw = await safeJson(response);
  if (!response.ok) throw responseError(providerName, response.status);
  return raw;
}

async function openAiStyleModelList(account: ProviderAccountRuntime, path = "/v1/models", extraHeaders: Record<string, string> = {}) {
  const baseUrl = await providerBaseUrlForRequest(account.provider, adapters[account.provider].defaultBaseUrl, account.baseUrl);
  const providerName = providerDisplayName(account.provider);
  const response = await fetchWithTimeout(openAiStyleEndpoint(baseUrl, path), {
    headers: jsonHeaders(account.apiKey, extraHeaders)
  }, MODEL_LIST_TIMEOUT_MS, providerName);
  const raw = await safeJson(response);
  if (!response.ok) {
    throw new ProviderFetchError({
      code: "provider_request_failed",
      message: publicProviderError(providerName, response.status),
      retryable: response.status >= 500 || response.status === 429,
      status: response.status
    });
  }
  return modelSnapshotsFromOpenAIList(raw);
}

function openAiStyleEndpoint(baseUrl: string, path: string) {
  if (baseUrl.endsWith("/v1") && path.startsWith("/v1/")) return `${baseUrl}${path.slice(3)}`;
  return `${baseUrl}${path}`;
}

function objectValue(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function modelArray(raw: unknown, field: string): Record<string, unknown>[] {
  const values = objectValue(raw)[field];
  return Array.isArray(values) ? values.filter((value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)) : [];
}

function namedSnapshots(values: Record<string, unknown>[], idField = "id", nameField = "name") {
  return values.flatMap((model) => {
    const id = model[idField];
    if (typeof id !== "string" || !id.trim()) return [];
    const name = model[nameField];
    return [{ id, displayName: typeof name === "string" && name.trim() ? name : id, raw: model }];
  });
}

function numberFromUnknown(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeOpenAiUsage(raw: unknown): NormalizedUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const completionDetails = usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
    ? usage.completion_tokens_details as Record<string, unknown>
    : null;
  const promptDetails = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
    ? usage.prompt_tokens_details as Record<string, unknown>
    : null;
  const normalized: NormalizedUsage = {
    inputTokens: numberFromUnknown(usage.prompt_tokens) ?? numberFromUnknown(usage.input_tokens),
    outputTokens: numberFromUnknown(usage.completion_tokens) ?? numberFromUnknown(usage.output_tokens),
    reasoningTokens: numberFromUnknown(completionDetails?.reasoning_tokens) ?? numberFromUnknown(usage.reasoning_tokens),
    searchQueries: numberFromUnknown(usage.num_search_queries) ?? numberFromUnknown(usage.search_queries) ?? numberFromUnknown(promptDetails?.search_queries)
  };
  return Object.values(normalized).some((value) => typeof value === "number") ? normalized : undefined;
}

function normalizeAnthropicUsage(raw: unknown): NormalizedUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const normalized: NormalizedUsage = {
    inputTokens: numberFromUnknown(usage.input_tokens),
    outputTokens: numberFromUnknown(usage.output_tokens)
  };
  return Object.values(normalized).some((value) => typeof value === "number") ? normalized : undefined;
}

function mergeUsage(current: NormalizedUsage | undefined, next: NormalizedUsage | undefined): NormalizedUsage | undefined {
  if (!next) return current;
  return {
    inputTokens: next.inputTokens ?? current?.inputTokens,
    outputTokens: next.outputTokens ?? current?.outputTokens,
    reasoningTokens: next.reasoningTokens ?? current?.reasoningTokens,
    searchQueries: next.searchQueries ?? current?.searchQueries
  };
}

function streamIncompleteEvent(providerName: string): StreamEvent {
  return {
    type: "error",
    error: {
      code: "provider_stream_incomplete",
      message: `${providerName} stream ended before a completion event.`,
      retryable: true
    }
  };
}

function providerStreamErrorEvent(providerName: string, rawError: unknown): StreamEvent {
  const error = rawError && typeof rawError === "object" ? rawError as Record<string, unknown> : {};
  return {
    type: "error",
    error: {
      code: typeof error.code === "string" ? error.code : typeof error.type === "string" ? error.type : "provider_stream_error",
      message: `${providerName} returned a stream error. Check the provider dashboard or server logs for details.`,
      retryable: false,
      status: numberFromUnknown(error.status)
    }
  };
}

function publicProviderError(providerName: string, status: number): string {
  return `${providerName} returned ${status}. Check the provider dashboard or server logs for details.`;
}

const openAiCompatibleAdapter: ProviderAdapter = {
  id: "openai-compatible",
  defaultBaseUrl: "https://api.openai.com",
  async test(account) {
    try {
      const models = await this.listModels(account);
      return { ok: true, message: `Connected. ${models.length} models discovered.`, models };
    } catch (error) {
      return testFailureResult(error, providerDisplayName(account.provider));
    }
  },
  async listModels(account) {
    return openAiStyleModelList(account);
  },
  streamChat(account, request, options) {
    return streamOpenAiCompatible(account, request, {}, options);
  }
};

const openAiAdapter: ProviderAdapter = {
  id: "openai",
  defaultBaseUrl: "https://api.openai.com",
  async test(account) {
    try {
      const models = await this.listModels(account);
      return { ok: true, message: `Connected. ${models.length} models discovered.`, models };
    } catch (error) {
      return testFailureResult(error, "OpenAI");
    }
  },
  listModels(account) { return openAiStyleModelList(account); },
  streamChat(account, request, options) { return streamResponses(account, request, options); }
};

const xAiAdapter: ProviderAdapter = {
  id: "xai",
  defaultBaseUrl: "https://api.x.ai",
  async test(account) {
    try {
      const models = await this.listModels(account);
      return { ok: true, message: `Connected. ${models.length} language models discovered.`, models };
    } catch (error) {
      return testFailureResult(error, "xAI");
    }
  },
  async listModels(account) {
    const raw = await modelListJson(account, "/v1/language-models", jsonHeaders(account.apiKey));
    return namedSnapshots(modelArray(raw, "models"), "id", "id");
  },
  streamChat(account, request, options) { return streamResponses(account, request, options); }
};

const googleAdapter: ProviderAdapter = {
  id: "google",
  defaultBaseUrl: "https://generativelanguage.googleapis.com",
  async test(account) {
    try {
      const models = await this.listModels(account);
      return { ok: true, message: `Connected. ${models.length} generative models discovered.`, models };
    } catch (error) {
      return testFailureResult(error, "Google Gemini");
    }
  },
  async listModels(account) {
    const models: ProviderModelSnapshot[] = [];
    let pageToken: string | undefined;
    const seen = new Set<string>();
    const seenPageTokens = new Set<string>();
    do {
      if (pageToken) {
        if (seenPageTokens.has(pageToken)) throw new Error("Google Gemini returned a repeated model page token");
        seenPageTokens.add(pageToken);
      }
      const query = new URLSearchParams({ pageSize: "1000" });
      if (pageToken) query.set("pageToken", pageToken);
      const raw = await modelListJson(account, `/v1beta/models?${query}`, { "x-goog-api-key": account.apiKey }, "Google Gemini");
      for (const model of modelArray(raw, "models")) {
        const name = model.name;
        const actions = model.supportedGenerationMethods ?? model.supported_actions;
        if (typeof name !== "string" || !name.startsWith("models/") || !Array.isArray(actions) || !actions.includes("generateContent")) continue;
        const id = name.slice("models/".length);
        if (seen.has(id)) continue;
        seen.add(id);
        models.push({ id, displayName: typeof model.displayName === "string" ? model.displayName : id, raw: model });
      }
      const next = objectValue(raw).nextPageToken;
      pageToken = typeof next === "string" && next ? next : undefined;
      if (pageToken && models.length >= 5000) throw new Error("Google Gemini model catalog exceeds the supported sync size");
    } while (pageToken);
    return models;
  },
  streamChat(account, request, options) { return streamGoogle(account, request, options); }
};

const sugarAdapter: ProviderAdapter = {
  id: "sugar",
  defaultBaseUrl: "https://usesugar.dev/api/v1",
  async test(account) {
    try {
      const models = await this.listModels(account);
      return { ok: true, message: `Connected. ${models.length} models discovered.`, models };
    } catch (error) {
      return testFailureResult(error, "Sugar");
    }
  },
  listModels(account) { return openAiStyleModelList(account); },
  streamChat(account, request, options) { return streamOpenAiCompatible(account, request, {}, options); }
};

const openCodeGoAdapter: ProviderAdapter = {
  id: "opencode-go",
  defaultBaseUrl: "https://opencode.ai/zen/go/v1",
  async test(account) {
    try {
      const models = await this.listModels(account);
      return { ok: true, message: `Catalog reached: ${models.length} models. Model access requires a live request.`, models };
    } catch (error) {
      return testFailureResult(error, "OpenCode Go");
    }
  },
  listModels(account) { return openAiStyleModelList(account); },
  streamChat(account, request, options) { return streamOpenCodeGo(account, request, options); }
};

const ollamaCloudAdapter: ProviderAdapter = {
  id: "ollama-cloud",
  defaultBaseUrl: "https://ollama.com",
  async test(account) {
    try {
      const models = await this.listModels(account);
      return { ok: true, message: `Catalog reached: ${models.length} models. Subscription access requires a live request.`, models };
    } catch (error) {
      return testFailureResult(error, "Ollama Cloud");
    }
  },
  async listModels(account) {
    const raw = await modelListJson(account, "/api/tags", jsonHeaders(account.apiKey));
    return namedSnapshots(modelArray(raw, "models"), "name", "name");
  },
  streamChat(account, request, options) { return streamOpenAiCompatible(account, request, {}, options); }
};

const clinePassAdapter: ProviderAdapter = {
  id: "cline-pass",
  defaultBaseUrl: "https://api.cline.bot/api/v1",
  async test(account) {
    try {
      const models = await this.listModels(account);
      return { ok: true, message: `ClinePass catalog reached: ${models.length} models. Key and plan access require a live request.`, models };
    } catch (error) {
      return testFailureResult(error, "ClinePass");
    }
  },
  async listModels(account) {
    const raw = await modelListJson(account, "/v1/ai/cline/recommended-models", jsonHeaders(account.apiKey));
    return namedSnapshots(modelArray(raw, "clinePass"));
  },
  streamChat(account, request, options) { return streamOpenAiCompatible(account, request, {}, options); }
};

const azureOpenAiAdapter: ProviderAdapter = {
  id: "azure-openai",
  defaultBaseUrl: "https://example.openai.azure.com",
  async test(account) {
    try {
      const models = await this.listModels(account);
      return { ok: true, message: `Connected. ${models.length} deployments discovered.`, models };
    } catch (error) {
      return testFailureResult(error, "Azure OpenAI");
    }
  },
  async listModels(account) {
    const baseUrl = await providerBaseUrlForRequest(account.provider, this.defaultBaseUrl, account.baseUrl);
    const apiVersion = account.apiVersion || "2024-10-21";
    const response = await fetchWithTimeout(`${baseUrl}/openai/deployments?api-version=${apiVersion}`, {
      headers: { "api-key": account.apiKey }
    }, MODEL_LIST_TIMEOUT_MS, "Azure OpenAI");
    const raw = await safeJson(response);
    if (!response.ok) {
      throw new ProviderFetchError({
        code: "provider_request_failed",
        message: publicProviderError("Azure OpenAI", response.status),
        retryable: response.status >= 500 || response.status === 429,
        status: response.status
      });
    }
    const data = raw && typeof raw === "object" && "data" in raw ? (raw as { data?: Array<{ id?: string; model?: string }> }).data : [];
    return (data ?? []).filter((deployment) => deployment.id).map((deployment) => ({ id: deployment.id!, displayName: deployment.model ?? deployment.id!, raw: deployment }));
  },
  streamChat(account, request, options) {
    return streamOpenAiCompatible(account, request, { azure: true }, options);
  }
};

const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  defaultBaseUrl: "https://api.anthropic.com",
  async test(account) {
    try {
      const models = await this.listModels(account);
      return { ok: true, message: `Connected. ${models.length} models discovered.`, models };
    } catch (error) {
      return testFailureResult(error, "Anthropic");
    }
  },
  async listModels(account) {
    const baseUrl = await providerBaseUrlForRequest(account.provider, this.defaultBaseUrl, account.baseUrl);
    const models: ProviderModelSnapshot[] = [];
    let afterId: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "1000" });
      if (afterId) query.set("after_id", afterId);
      const response = await fetchWithTimeout(`${baseUrl}/v1/models?${query}`, {
        headers: { "x-api-key": account.apiKey, "anthropic-version": "2023-06-01" }
      }, MODEL_LIST_TIMEOUT_MS, "Anthropic");
      const raw = await safeJson(response);
      if (!response.ok) throw responseError("Anthropic", response.status);
      const data = modelArray(raw, "data");
      models.push(...namedSnapshots(data, "id", "display_name"));
      const page = objectValue(raw);
      if (page.has_more === true) {
        if (typeof page.last_id !== "string" || !page.last_id || page.last_id === afterId) throw new Error("Anthropic returned an incomplete model catalog page");
        afterId = page.last_id;
      } else afterId = undefined;
      if (afterId && models.length >= 5000) throw new Error("Anthropic model catalog exceeds the supported sync size");
    } while (afterId);
    return models;
  },
  streamChat(account, request, options) {
    return streamAnthropic(account, request, options);
  }
};

const perplexityAdapter: ProviderAdapter = {
  id: "perplexity",
  defaultBaseUrl: "https://api.perplexity.ai",
  async test(account) {
    try {
      const models = await this.listModels(account);
      return { ok: true, message: `Connected. ${models.length} models discovered.`, models };
    } catch (error) {
      if (isUnsupportedModelDiscovery(error)) {
        return { ok: true, message: "Perplexity endpoint reached, but model discovery is not supported by this endpoint." };
      }
      return testFailureResult(error, "Perplexity");
    }
  },
  async listModels(account) {
    return openAiStyleModelList(account);
  },
  streamChat(account, request, options) {
    return streamOpenAiCompatible(account, request, {}, options);
  }
};

const minimaxAdapter: ProviderAdapter = {
  id: "minimax",
  defaultBaseUrl: "https://api.minimax.io",
  async test(account) {
    try {
      const models = await this.listModels(account);
      return { ok: true, message: `Connected. ${models.length} models discovered.`, models };
    } catch (error) {
      if (isUnsupportedModelDiscovery(error)) {
        return { ok: true, message: "Minimax endpoint reached, but model discovery is not supported by this endpoint." };
      }
      return testFailureResult(error, "Minimax");
    }
  },
  async listModels(account) {
    return openAiStyleModelList(account);
  },
  streamChat(account, request, options) {
    return streamOpenAiCompatible(account, request, {}, options);
  }
};

export const adapters: Record<ProviderId, ProviderAdapter> = {
  "openai-compatible": openAiCompatibleAdapter,
  openai: openAiAdapter,
  "azure-openai": azureOpenAiAdapter,
  anthropic: anthropicAdapter,
  google: googleAdapter,
  xai: xAiAdapter,
  sugar: sugarAdapter,
  "opencode-go": openCodeGoAdapter,
  "ollama-cloud": ollamaCloudAdapter,
  "cline-pass": clinePassAdapter,
  perplexity: perplexityAdapter,
  minimax: minimaxAdapter
};

export { isUnsupportedModelDiscovery, normalizeFetchError, validateProviderBaseUrl } from "./provider-http";

export function getProviderAdapter(provider: ProviderId): ProviderAdapter {
  return adapters[provider];
}

async function* streamOpenAiCompatible(
  account: ProviderAccountRuntime,
  request: NormalizedChatRequest,
  options: { azure?: boolean } = {},
  streamOptions: StreamChatOptions = {}
): AsyncIterable<StreamEvent> {
  const responseId = randomUUID();
  yield { type: "message_start", responseId };

  let baseUrl: string;
  try {
    baseUrl = await providerBaseUrlForRequest(account.provider, adapters[account.provider].defaultBaseUrl, account.baseUrl);
  } catch (error) {
    yield streamErrorEvent(error, account.provider);
    return;
  }
  const apiVersion = account.apiVersion || "2024-10-21";
  const endpoint = options.azure
    ? `${baseUrl}/openai/deployments/${encodeURIComponent(request.model)}/chat/completions?api-version=${apiVersion}`
    : openAiStyleEndpoint(baseUrl, "/v1/chat/completions");

  const headers = options.azure ? { "content-type": "application/json", "api-key": account.apiKey } : jsonHeaders(account.apiKey);
  const payload: Record<string, unknown> = {
    model: options.azure ? undefined : request.model,
    messages: request.messages.map((message) => ({
      role: message.role === "developer" ? "system" : message.role,
      content: message.content.map((part) => part.text).join("\n")
    })),
    temperature: request.temperature,
    max_tokens: request.maxOutputTokens,
    stream: true
  };
  if (account.provider !== "minimax") payload.stream_options = { include_usage: true };

  let response: Response;
  try {
    response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: streamOptions.signal
    }, STREAM_CONNECT_TIMEOUT_MS, account.provider);
  } catch (error) {
    yield streamErrorEvent(error, account.provider);
    return;
  }

  if (!response.ok || !response.body) {
    await safeJson(response);
    yield {
      type: "error",
      error: {
        code: "provider_request_failed",
        message: publicProviderError(providerDisplayName(account.provider), response.status),
        retryable: response.status >= 500 || response.status === 429,
        status: response.status
      }
    };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: NormalizedUsage | undefined;
  let finishReason = "stop";

  try {
    while (true) {
      const { done, value } = await readWithTimeout(reader, STREAM_READ_TIMEOUT_MS, account.provider, streamOptions.signal);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          yield { type: "message_end", finishReason, usage };
          return;
        }
        try {
          const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>; usage?: unknown; error?: unknown };
          if (chunk.error) {
            yield providerStreamErrorEvent(providerDisplayName(account.provider), chunk.error);
            return;
          }
          usage = mergeUsage(usage, normalizeOpenAiUsage(chunk.usage));
          const content = chunk.choices?.[0]?.delta?.content;
          if (content) yield { type: "text_delta", text: content };
          finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
        } catch {
          // Ignore malformed provider keepalive chunks.
        }
      }
    }
    yield streamIncompleteEvent(providerDisplayName(account.provider));
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    yield streamErrorEvent(error, account.provider);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function responsesPayload(request: NormalizedChatRequest, store?: boolean) {
  return {
    model: request.model,
    input: request.messages.map((message) => ({
      role: message.role === "tool" ? "user" : message.role,
      content: message.content.map((part) => part.text).join("\n")
    })),
    max_output_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    store,
    stream: true
  };
}

function anthropicPayload(request: NormalizedChatRequest) {
  return {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? 4096,
    temperature: request.temperature,
    system: request.messages.filter((message) => message.role === "system" || message.role === "developer")
      .map((message) => message.content.map((part) => part.text).join("\n")).join("\n\n") || undefined,
    messages: request.messages.filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, content: message.content.map((part) => part.text).join("\n") })),
    stream: true
  };
}

function chatPayload(request: NormalizedChatRequest) {
  return {
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role === "developer" || message.role === "tool" ? "system" : message.role,
      content: message.content.map((part) => part.text).join("\n")
    })),
    max_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    stream: true,
    stream_options: { include_usage: true }
  };
}

async function* sseData(response: Response, providerName: string, signal?: AbortSignal): AsyncIterable<string> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await readWithTimeout(reader, STREAM_READ_TIMEOUT_MS, providerName, signal);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data) yield data;
        boundary = buffer.indexOf("\n\n");
      }
    }
    const data = buffer.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (data) yield data;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

type StreamWireFormat = "responses" | "chat" | "anthropic" | "google";

async function* parseStructuredStream(response: Response, format: StreamWireFormat, providerName: string, signal?: AbortSignal): AsyncIterable<StreamEvent> {
  let usage: NormalizedUsage | undefined;
  let finishReason = "stop";
  let sawText = false;
  let ended = false;
  try {
    for await (const data of sseData(response, providerName, signal)) {
      if (data === "[DONE]") {
        if (format === "chat") {
          ended = true;
          yield { type: "message_end", finishReason, usage };
        }
        break;
      }
      let raw: Record<string, unknown>;
      try { raw = objectValue(JSON.parse(data)); } catch { continue; }
      if (raw.error) {
        yield providerStreamErrorEvent(providerName, raw.error);
        return;
      }
      if (raw.type === "error") {
        yield providerStreamErrorEvent(providerName, raw);
        return;
      }
      if (format === "responses") {
        if (raw.type === "response.output_text.delta" && typeof raw.delta === "string") {
          sawText = true;
          yield { type: "text_delta", text: raw.delta };
        }
        if (raw.type === "response.completed") {
          usage = mergeUsage(usage, normalizeOpenAiUsage(objectValue(raw.response).usage));
          ended = true;
          yield { type: "message_end", finishReason, usage };
          return;
        }
        if (raw.type === "response.failed" || raw.type === "response.incomplete") {
          yield providerStreamErrorEvent(providerName, objectValue(raw.response).error ?? raw);
          return;
        }
      } else if (format === "chat") {
        usage = mergeUsage(usage, normalizeOpenAiUsage(raw.usage));
        const choice = Array.isArray(raw.choices) ? objectValue(raw.choices[0]) : {};
        const delta = objectValue(choice.delta);
        if (typeof delta.content === "string" && delta.content) {
          sawText = true;
          yield { type: "text_delta", text: delta.content };
        }
        if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
      } else if (format === "anthropic") {
        usage = mergeUsage(usage, normalizeAnthropicUsage(objectValue(raw.message).usage));
        usage = mergeUsage(usage, normalizeAnthropicUsage(raw.usage));
        const delta = objectValue(raw.delta);
        if (raw.type === "content_block_delta" && typeof delta.text === "string") {
          sawText = true;
          yield { type: "text_delta", text: delta.text };
        }
        if (typeof delta.stop_reason === "string") finishReason = delta.stop_reason;
        if (raw.type === "message_stop") {
          ended = true;
          yield { type: "message_end", finishReason, usage };
          return;
        }
      } else {
        const metadata = objectValue(raw.usageMetadata);
        usage = mergeUsage(usage, {
          inputTokens: numberFromUnknown(metadata.promptTokenCount),
          outputTokens: numberFromUnknown(metadata.candidatesTokenCount)
        });
        const candidate = Array.isArray(raw.candidates) ? objectValue(raw.candidates[0]) : {};
        const content = objectValue(candidate.content);
        const parts = Array.isArray(content.parts) ? content.parts : [];
        for (const part of parts) {
          const partRecord = objectValue(part);
          if (partRecord.thought === true) continue;
          const text = partRecord.text;
          if (typeof text === "string" && text) {
            sawText = true;
            yield { type: "text_delta", text };
          }
        }
        if (typeof candidate.finishReason === "string") finishReason = candidate.finishReason;
      }
    }
    if (format === "google" && sawText) {
      yield { type: "message_end", finishReason, usage };
      return;
    }
    if (!ended) yield streamIncompleteEvent(providerName);
  } catch (error) {
    yield streamErrorEvent(error, providerName);
  }
}

async function* streamResponses(account: ProviderAccountRuntime, request: NormalizedChatRequest, options: StreamChatOptions = {}): AsyncIterable<StreamEvent> {
  yield { type: "message_start", responseId: randomUUID() };
  const providerName = providerDisplayName(account.provider);
  try {
    const baseUrl = await providerBaseUrlForRequest(account.provider, adapters[account.provider].defaultBaseUrl, account.baseUrl);
    const response = await fetchWithTimeout(openAiStyleEndpoint(baseUrl, "/v1/responses"), {
      method: "POST", headers: jsonHeaders(account.apiKey), body: JSON.stringify(responsesPayload(request, false)), signal: options.signal
    }, STREAM_CONNECT_TIMEOUT_MS, providerName);
    if (!response.ok || !response.body) {
      await safeJson(response);
      yield streamErrorEvent(responseError(providerName, response.status), providerName);
      return;
    }
    yield* parseStructuredStream(response, "responses", providerName, options.signal);
  } catch (error) {
    yield streamErrorEvent(error, providerName);
  }
}

async function* streamGoogle(account: ProviderAccountRuntime, request: NormalizedChatRequest, options: StreamChatOptions = {}): AsyncIterable<StreamEvent> {
  yield { type: "message_start", responseId: randomUUID() };
  try {
    const baseUrl = await providerBaseUrlForRequest(account.provider, googleAdapter.defaultBaseUrl, account.baseUrl);
    const systemInstruction = request.messages.filter((message) => message.role === "system" || message.role === "developer")
      .map((message) => message.content.map((part) => part.text).join("\n")).join("\n\n");
    const contents = request.messages.filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content.map((part) => part.text).join("\n") }] }));
    const response = await fetchWithTimeout(`${baseUrl}/v1beta/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": account.apiKey },
      body: JSON.stringify({
        contents,
        systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
        generationConfig: { temperature: request.temperature, maxOutputTokens: request.maxOutputTokens }
      }),
      signal: options.signal
    }, STREAM_CONNECT_TIMEOUT_MS, "Google Gemini");
    if (!response.ok || !response.body) {
      await safeJson(response);
      yield streamErrorEvent(responseError("Google Gemini", response.status), "Google Gemini");
      return;
    }
    yield* parseStructuredStream(response, "google", "Google Gemini", options.signal);
  } catch (error) {
    yield streamErrorEvent(error, "Google Gemini");
  }
}

async function* streamOpenCodeGo(account: ProviderAccountRuntime, request: NormalizedChatRequest, options: StreamChatOptions = {}): AsyncIterable<StreamEvent> {
  yield { type: "message_start", responseId: randomUUID() };
  try {
    const baseUrl = await providerBaseUrlForRequest(account.provider, openCodeGoAdapter.defaultBaseUrl, account.baseUrl);
    const sessionId = options.sessionId ?? randomUUID();
    const attempts: Array<{ path: string; format: StreamWireFormat; payload: unknown }> = [
      { path: "/v1/chat/completions", format: "chat", payload: chatPayload(request) },
      { path: "/v1/responses", format: "responses", payload: responsesPayload(request) },
      { path: "/v1/messages", format: "anthropic", payload: anthropicPayload(request) }
    ];
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index]!;
      const response = await fetchWithTimeout(openAiStyleEndpoint(baseUrl, attempt.path), {
        method: "POST",
        headers: jsonHeaders(account.apiKey, {
          "user-agent": "PacketChat/0.1",
          "x-opencode-session": sessionId,
          ...(attempt.format === "anthropic" ? { "x-api-key": account.apiKey, "anthropic-version": "2023-06-01" } : {})
        }),
        body: JSON.stringify(attempt.payload),
        signal: options.signal
      }, STREAM_CONNECT_TIMEOUT_MS, "OpenCode Go");
      if (response.ok && response.body) {
        yield* parseStructuredStream(response, attempt.format, "OpenCode Go", options.signal);
        return;
      }
      await safeJson(response);
      if (index === attempts.length - 1 || ![400, 404, 405, 422, 501].includes(response.status)) {
        yield streamErrorEvent(responseError("OpenCode Go", response.status), "OpenCode Go");
        return;
      }
    }
  } catch (error) {
    yield streamErrorEvent(error, "OpenCode Go");
  }
}

async function* streamAnthropic(account: ProviderAccountRuntime, request: NormalizedChatRequest, streamOptions: StreamChatOptions = {}): AsyncIterable<StreamEvent> {
  const responseId = randomUUID();
  yield { type: "message_start", responseId };

  let baseUrl: string;
  try {
    baseUrl = await providerBaseUrlForRequest(account.provider, adapters.anthropic.defaultBaseUrl, account.baseUrl);
  } catch (error) {
    yield streamErrorEvent(error, "Anthropic");
    return;
  }
  const system = request.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .flatMap((message) => message.content)
    .map((part) => part.text)
    .join("\n\n");

  const messages = request.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role,
      content: message.content.map((part) => part.text).join("\n")
    }));

  let response: Response;
  try {
    response = await fetchWithTimeout(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": account.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxOutputTokens ?? 4096,
        temperature: request.temperature,
        system: system || undefined,
        messages,
        stream: true
      }),
      signal: streamOptions.signal
    }, STREAM_CONNECT_TIMEOUT_MS, "Anthropic");
  } catch (error) {
    yield streamErrorEvent(error, "Anthropic");
    return;
  }

  if (!response.ok || !response.body) {
    const raw = await safeJson(response);
    yield {
      type: "error",
      error: {
        code: "provider_request_failed",
        message: publicProviderError("Anthropic", response.status),
        retryable: response.status >= 500 || response.status === 429,
        status: response.status
      }
    };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: NormalizedUsage | undefined;
  let ended = false;

  try {
    while (true) {
      const { done, value } = await readWithTimeout(reader, STREAM_READ_TIMEOUT_MS, "Anthropic", streamOptions.signal);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const event = JSON.parse(data) as {
            type?: string;
            message?: { usage?: unknown };
            delta?: { text?: string; stop_reason?: string };
            usage?: unknown;
            error?: { message?: string; type?: string };
          };
          if (event.type === "message_start") usage = mergeUsage(usage, normalizeAnthropicUsage(event.message?.usage));
          usage = mergeUsage(usage, normalizeAnthropicUsage(event.usage));
          if (event.type === "content_block_delta" && event.delta?.text) {
            yield { type: "text_delta", text: event.delta.text };
          }
          if (event.type === "message_delta" && event.delta?.stop_reason && !ended) {
            ended = true;
            yield { type: "message_end", finishReason: event.delta.stop_reason, usage };
          }
          if (event.type === "message_stop") {
            if (!ended) yield { type: "message_end", finishReason: "stop", usage };
            return;
          }
          if (event.type === "error") {
            yield {
              type: "error",
              error: {
                code: event.error?.type ?? "anthropic_error",
                message: "Anthropic returned a stream error. Check server logs or provider dashboard for details.",
                retryable: false
              }
            };
            return;
          }
        } catch {
          // Ignore malformed provider keepalive chunks.
        }
      }
    }
    yield streamIncompleteEvent("Anthropic");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    yield streamErrorEvent(error, "Anthropic");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
