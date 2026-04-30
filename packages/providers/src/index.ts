import type { NormalizedChatRequest, NormalizedUsage, ProviderId, StreamEvent } from "@packetchat/contracts";
import { randomUUID } from "node:crypto";
import {
  fetchWithTimeout,
  isUnsupportedModelDiscovery,
  MODEL_LIST_TIMEOUT_MS,
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
  streamChat(account: ProviderAccountRuntime, request: NormalizedChatRequest): AsyncIterable<StreamEvent>;
}

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
  if (!raw || typeof raw !== "object" || !("data" in raw) || !Array.isArray((raw as { data: unknown }).data)) return [];
  return (raw as { data: Array<{ id?: string }> }).data
    .filter((model) => typeof model.id === "string")
    .map((model) => ({ id: model.id!, displayName: model.id!, raw: model }));
}

async function openAiStyleModelList(account: ProviderAccountRuntime, path = "/v1/models", extraHeaders: Record<string, string> = {}) {
  const baseUrl = (account.baseUrl || adapters[account.provider].defaultBaseUrl).replace(/\/$/, "");
  const providerName = providerDisplayName(account.provider);
  const response = await fetchWithTimeout(`${baseUrl}${path}`, {
    headers: jsonHeaders(account.apiKey, extraHeaders)
  }, MODEL_LIST_TIMEOUT_MS, providerName);
  const raw = await safeJson(response);
  if (!response.ok) {
    throw new ProviderFetchError({
      code: "provider_request_failed",
      message: `${providerName} returned ${response.status}: ${JSON.stringify(raw)}`,
      retryable: response.status >= 500 || response.status === 429,
      status: response.status
    });
  }
  return modelSnapshotsFromOpenAIList(raw);
}

async function* notImplementedStream(provider: ProviderId): AsyncIterable<StreamEvent> {
  yield { type: "message_start", responseId: randomUUID() };
  yield {
    type: "error",
    error: {
      code: "provider_stream_not_implemented",
      message: `${provider} streaming is scaffolded but not implemented yet`,
      retryable: false
    }
  };
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
  streamChat(account, request) {
    return streamOpenAiCompatible(account, request);
  }
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
    const baseUrl = (account.baseUrl || this.defaultBaseUrl).replace(/\/$/, "");
    const apiVersion = account.apiVersion || "2024-10-21";
    const response = await fetchWithTimeout(`${baseUrl}/openai/deployments?api-version=${apiVersion}`, {
      headers: { "api-key": account.apiKey }
    }, MODEL_LIST_TIMEOUT_MS, "Azure OpenAI");
    const raw = await safeJson(response);
    if (!response.ok) {
      throw new ProviderFetchError({
        code: "provider_request_failed",
        message: `Azure OpenAI returned ${response.status}: ${JSON.stringify(raw)}`,
        retryable: response.status >= 500 || response.status === 429,
        status: response.status
      });
    }
    const data = raw && typeof raw === "object" && "data" in raw ? (raw as { data?: Array<{ id?: string; model?: string }> }).data : [];
    return (data ?? []).filter((deployment) => deployment.id).map((deployment) => ({ id: deployment.id!, displayName: deployment.model ?? deployment.id!, raw: deployment }));
  },
  streamChat(account, request) {
    return streamOpenAiCompatible(account, request, { azure: true });
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
    const baseUrl = (account.baseUrl || this.defaultBaseUrl).replace(/\/$/, "");
    const response = await fetchWithTimeout(`${baseUrl}/v1/models`, {
      headers: {
        "x-api-key": account.apiKey,
        "anthropic-version": "2023-06-01"
      }
    }, MODEL_LIST_TIMEOUT_MS, "Anthropic");
    const raw = await safeJson(response);
    if (!response.ok) {
      throw new ProviderFetchError({
        code: "provider_request_failed",
        message: `Anthropic returned ${response.status}: ${JSON.stringify(raw)}`,
        retryable: response.status >= 500 || response.status === 429,
        status: response.status
      });
    }
    const data = raw && typeof raw === "object" && "data" in raw ? (raw as { data?: Array<{ id?: string; display_name?: string }> }).data : [];
    return (data ?? []).filter((model) => model.id).map((model) => ({ id: model.id!, displayName: model.display_name ?? model.id!, raw: model }));
  },
  streamChat(account, request) {
    return streamAnthropic(account, request);
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
  streamChat(account, request) {
    return streamOpenAiCompatible(account, request);
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
  streamChat(account, request) {
    return streamOpenAiCompatible(account, request);
  }
};

export const adapters: Record<ProviderId, ProviderAdapter> = {
  "openai-compatible": openAiCompatibleAdapter,
  "azure-openai": azureOpenAiAdapter,
  anthropic: anthropicAdapter,
  perplexity: perplexityAdapter,
  minimax: minimaxAdapter
};

export function getProviderAdapter(provider: ProviderId): ProviderAdapter {
  return adapters[provider];
}

async function* streamOpenAiCompatible(
  account: ProviderAccountRuntime,
  request: NormalizedChatRequest,
  options: { azure?: boolean } = {}
): AsyncIterable<StreamEvent> {
  const responseId = randomUUID();
  yield { type: "message_start", responseId };

  const baseUrl = (account.baseUrl || adapters[account.provider].defaultBaseUrl).replace(/\/$/, "");
  const apiVersion = account.apiVersion || "2024-10-21";
  const endpoint = options.azure
    ? `${baseUrl}/openai/deployments/${encodeURIComponent(request.model)}/chat/completions?api-version=${apiVersion}`
    : `${baseUrl}/v1/chat/completions`;

  const headers = options.azure ? { "content-type": "application/json", "api-key": account.apiKey } : jsonHeaders(account.apiKey);
  const payload: Record<string, unknown> = {
    model: options.azure ? undefined : request.model,
    messages: request.messages.map((message) => ({
      role: message.role === "developer" ? "system" : message.role,
      content: message.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n")
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
      body: JSON.stringify(payload)
    }, STREAM_CONNECT_TIMEOUT_MS, account.provider);
  } catch (error) {
    yield streamErrorEvent(error, account.provider);
    return;
  }

  if (!response.ok || !response.body) {
    const raw = await safeJson(response);
    yield {
      type: "error",
      error: {
        code: "provider_request_failed",
        message: `Provider returned ${response.status}: ${JSON.stringify(raw)}`,
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
      const { done, value } = await readWithTimeout(reader, STREAM_READ_TIMEOUT_MS, account.provider);
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
          const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>; usage?: unknown };
          usage = mergeUsage(usage, normalizeOpenAiUsage(chunk.usage));
          const content = chunk.choices?.[0]?.delta?.content;
          if (content) yield { type: "text_delta", text: content };
          finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
        } catch {
          // Ignore malformed provider keepalive chunks.
        }
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    yield streamErrorEvent(error, account.provider);
  } finally {
    reader.releaseLock();
  }
}

async function* streamAnthropic(account: ProviderAccountRuntime, request: NormalizedChatRequest): AsyncIterable<StreamEvent> {
  const responseId = randomUUID();
  yield { type: "message_start", responseId };

  const baseUrl = (account.baseUrl || adapters.anthropic.defaultBaseUrl).replace(/\/$/, "");
  const system = request.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .flatMap((message) => message.content)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");

  const messages = request.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role,
      content: message.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n")
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
      })
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
        message: `Anthropic returned ${response.status}: ${JSON.stringify(raw)}`,
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
      const { done, value } = await readWithTimeout(reader, STREAM_READ_TIMEOUT_MS, "Anthropic");
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
                message: event.error?.message ?? "Anthropic stream error",
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
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    yield streamErrorEvent(error, "Anthropic");
  } finally {
    reader.releaseLock();
  }
}
