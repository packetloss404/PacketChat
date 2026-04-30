import type { ProviderId, StreamEvent } from "@packetchat/contracts";

export const MODEL_LIST_TIMEOUT_MS = 15_000;
export const STREAM_CONNECT_TIMEOUT_MS = 30_000;
export const STREAM_READ_TIMEOUT_MS = 120_000;

type ProviderFetchErrorOptions = {
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
  cause?: unknown;
};

export class ProviderFetchError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(options: ProviderFetchErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "ProviderFetchError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

export function providerDisplayName(provider: ProviderId) {
  switch (provider) {
    case "azure-openai":
      return "Azure OpenAI";
    case "openai-compatible":
      return "OpenAI-compatible provider";
    case "anthropic":
      return "Anthropic";
    case "perplexity":
      return "Perplexity";
    case "minimax":
      return "Minimax";
  }
}

function isAbortLike(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export function normalizeFetchError(error: unknown, providerName = "Provider"): ProviderFetchError {
  if (error instanceof ProviderFetchError) return error;
  if (isAbortLike(error)) {
    return new ProviderFetchError({
      code: "provider_request_timeout",
      message: `${providerName} request timed out`,
      retryable: true,
      cause: error
    });
  }
  if (error instanceof TypeError) {
    return new ProviderFetchError({
      code: "provider_network_error",
      message: `${providerName} network request failed: ${error.message}`,
      retryable: true,
      cause: error
    });
  }
  if (error instanceof Error) {
    return new ProviderFetchError({
      code: "provider_request_failed",
      message: error.message,
      retryable: false,
      cause: error
    });
  }
  return new ProviderFetchError({
    code: "provider_request_failed",
    message: `${providerName} request failed`,
    retryable: false,
    cause: error
  });
}

export async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  providerName = "Provider"
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timeout === "object" && "unref" in timeout && typeof timeout.unref === "function") timeout.unref();
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    throw normalizeFetchError(error, providerName);
  } finally {
    clearTimeout(timeout);
  }
}

export function isUnsupportedModelDiscovery(error: unknown) {
  return error instanceof ProviderFetchError && [404, 405, 501].includes(error.status ?? 0);
}

export function testFailureResult(error: unknown, providerName: string) {
  const normalized = normalizeFetchError(error, providerName);
  return {
    ok: false,
    message: normalized.status
      ? `${providerName} validation failed (${normalized.status}): ${normalized.message}`
      : `${providerName} validation failed: ${normalized.message}`
  };
}

export async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  providerName: string
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new ProviderFetchError({
        code: "provider_stream_timeout",
        message: `${providerName} stream timed out waiting for data`,
        retryable: true
      }));
    }, timeoutMs);
    if (typeof timeout === "object" && "unref" in timeout && typeof timeout.unref === "function") timeout.unref();
  });
  try {
    return await Promise.race([reader.read(), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function streamErrorEvent(error: unknown, providerName: string): StreamEvent {
  const normalized = normalizeFetchError(error, providerName);
  return {
    type: "error",
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      status: normalized.status
    }
  };
}
