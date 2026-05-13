import type { ProviderId, StreamEvent } from "@packetchat/contracts";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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

export type ProviderBaseUrlValidation =
  | { ok: true; value: string | null; local: boolean }
  | { ok: false; code: string; message: string };

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

function isLoopbackHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "host.docker.internal" || host === "gateway.docker.internal";
}

function isLoopbackAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || normalized.startsWith("127.");
}

function addressForCheck(address: string) {
  return address.toLowerCase().replace(/^\[|\]$/g, "");
}

function isBlockedIpv4(address: string) {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [first, second] = parts as [number, number, number, number];
  if (first === 0 || first === 10 || first === 127 || first >= 224) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && (second === 0 || second === 168)) return true;
  if (first === 198 && (second === 18 || second === 19 || second === 51)) return true;
  if (first === 203 && second === 0) return true;
  return false;
}

function isBlockedIpv6(address: string) {
  const normalized = address.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("ff")
  );
}

function isBlockedAddress(address: string) {
  const normalized = addressForCheck(address);
  if (isLoopbackAddress(normalized)) return true;
  const family = isIP(normalized);
  if (family === 4) return isBlockedIpv4(normalized);
  if (family === 6) return isBlockedIpv6(normalized);
  return true;
}

function isLocalOpenAiCompatibleUrl(provider: ProviderId, url: URL) {
  if (provider !== "openai-compatible") return false;
  if (isLoopbackHostname(url.hostname)) return true;
  const hostname = addressForCheck(url.hostname);
  return isIP(hostname) !== 0 && isLoopbackAddress(hostname);
}

export function validateProviderBaseUrl(provider: ProviderId, rawBaseUrl: string | null | undefined): ProviderBaseUrlValidation {
  const input = rawBaseUrl?.trim();
  if (!input) return { ok: true, value: null, local: false };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, code: "provider_base_url_invalid", message: "Provider base URL must be an absolute http(s) URL." };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, code: "provider_base_url_protocol_blocked", message: "Provider base URL must use https, or http for local OpenAI-compatible endpoints." };
  }
  if (url.username || url.password) {
    return { ok: false, code: "provider_base_url_credentials_blocked", message: "Provider base URL must not include embedded credentials." };
  }
  if (url.search || url.hash) {
    return { ok: false, code: "provider_base_url_shape_invalid", message: "Provider base URL must not include a query string or fragment." };
  }

  const local = isLocalOpenAiCompatibleUrl(provider, url);
  if (local) return { ok: true, value: url.toString().replace(/\/$/, ""), local: true };

  if (isLoopbackHostname(url.hostname)) {
    return { ok: false, code: "provider_base_url_local_blocked", message: "Local provider base URLs are only allowed for OpenAI-compatible accounts." };
  }
  const hostname = addressForCheck(url.hostname);
  if (isIP(hostname) && isBlockedAddress(hostname)) {
    return { ok: false, code: "provider_base_url_private_blocked", message: "Provider base URL must not target loopback, private, link-local, or reserved network addresses." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, code: "provider_base_url_insecure", message: "Non-local provider base URLs must use https." };
  }

  return { ok: true, value: url.toString().replace(/\/$/, ""), local: false };
}

export async function assertSafeProviderBaseUrl(provider: ProviderId, rawBaseUrl: string | null | undefined) {
  const validation = validateProviderBaseUrl(provider, rawBaseUrl);
  if (!validation.ok) {
    throw new ProviderFetchError({
      code: validation.code,
      message: validation.message,
      retryable: false
    });
  }

  if (validation.value && !validation.local) {
    const url = new URL(validation.value);
    const hostname = addressForCheck(url.hostname);
    if (!isIP(hostname)) {
      const records = await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
      if (records.length === 0 || records.some((record) => isBlockedAddress(record.address))) {
        throw new ProviderFetchError({
          code: "provider_base_url_dns_blocked",
          message: "Provider base URL could not be resolved to a public provider address.",
          retryable: false
        });
      }
    }
  }

  return validation.value;
}

export async function providerBaseUrlForRequest(provider: ProviderId, defaultBaseUrl: string, rawBaseUrl: string | null | undefined) {
  if (!rawBaseUrl?.trim()) return defaultBaseUrl.replace(/\/$/, "");
  const safeBaseUrl = await assertSafeProviderBaseUrl(provider, rawBaseUrl);
  return (safeBaseUrl ?? defaultBaseUrl).replace(/\/$/, "");
}

function isAbortLike(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function unrefTimeout(timeout: ReturnType<typeof setTimeout>) {
  if (typeof timeout === "object" && "unref" in timeout && typeof timeout.unref === "function") timeout.unref();
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
  const timeoutController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    timeoutController.abort(new DOMException("Request timed out", "TimeoutError"));
  }, timeoutMs);
  unrefTimeout(timeout);

  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    return await fetch(input, { redirect: "error", ...init, signal });
  } catch (error) {
    if (timedOut && isAbortLike(error)) {
      throw new ProviderFetchError({
        code: "provider_request_timeout",
        message: `${providerName} request timed out`,
        retryable: true,
        cause: error
      });
    }
    if (init.signal?.aborted && isAbortLike(error)) {
      throw new ProviderFetchError({
        code: "provider_request_cancelled",
        message: `${providerName} request was cancelled`,
        retryable: false,
        cause: error
      });
    }
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
  providerName: string,
  signal?: AbortSignal
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      reject(new ProviderFetchError({
        code: "provider_stream_timeout",
        message: `${providerName} stream timed out waiting for data`,
        retryable: true
      }));
    }, timeoutMs);
    unrefTimeout(timeout);
  });
  const abortPromise = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => {
      reject(new ProviderFetchError({
        code: "provider_stream_cancelled",
        message: `${providerName} stream was cancelled`,
        retryable: false
      }));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), timeoutPromise, abortPromise]);
  } catch (error) {
    if (timedOut) throw error;
    throw normalizeFetchError(error, providerName);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
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
