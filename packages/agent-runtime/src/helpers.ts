import { isIP } from "node:net";
import type { AgentSpec, RunFailureStatus } from "./types";

export function textOrNull(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function textMessageContent(text: string) {
  return [{ type: "text", text }];
}

export function termsFor(text: string) {
  return text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
}

export function snippetFor(content: string, terms: string[]) {
  const lower = content.toLowerCase();
  const firstHit = terms.reduce((best, term) => {
    const index = lower.indexOf(term);
    return index >= 0 && index < best ? index : best;
  }, Number.POSITIVE_INFINITY);
  const start = Number.isFinite(firstHit) ? Math.max(0, firstHit - 140) : 0;
  const snippet = content.slice(start, start + 360).trim();
  return `${start > 0 ? "..." : ""}${snippet}${start + 360 < content.length ? "..." : ""}`;
}

export function artifactInstructions(spec: AgentSpec) {
  if (!spec.artifacts?.enabled) return "";
  if (spec.artifacts.customPromptMode) return textOrNull(spec.artifacts.instructions) ?? "";
  const custom = textOrNull(spec.artifacts.instructions);
  return [
    "When creating content that should be displayed as an artifact, use this exact wrapper:",
    ":::artifact{identifier=\"unique-identifier\" type=\"mime-type\" title=\"Artifact Title\"}",
    "```",
    "artifact content",
    "```",
    ":::",
    "Allowed types: text/html, application/vnd.mermaid, application/vnd.react, image/svg+xml.",
    custom ? `Additional artifact guidance:\n${custom}` : ""
  ].filter(Boolean).join("\n");
}

export function parseCalculation(input: string) {
  const trimmed = input.trim().replace(/^calculate\s+/i, "").replace(/^what is\s+/i, "").replace(/\?$/, "").trim();
  if (!/^[\d\s+\-*/().]+$/.test(trimmed) || !/\d/.test(trimmed)) return null;
  let index = 0;
  const peek = () => trimmed[index];
  const skip = () => { while (trimmed[index] === " ") index += 1; };
  const number = (): number => {
    skip();
    let value = "";
    while (/[\d.]/.test(peek() ?? "")) value += trimmed[index++];
    if (!value || value.split(".").length > 2) throw new Error("Invalid number");
    return Number(value);
  };
  const factor = (): number => {
    skip();
    if (peek() === "-") {
      index += 1;
      return -factor();
    }
    if (peek() === "(") {
      index += 1;
      const value = expression();
      skip();
      if (peek() !== ")") throw new Error("Missing closing parenthesis");
      index += 1;
      return value;
    }
    return number();
  };
  const term = (): number => {
    let value = factor();
    while (true) {
      skip();
      if (peek() === "*") {
        index += 1;
        value *= factor();
      } else if (peek() === "/") {
        index += 1;
        const divisor = factor();
        if (divisor === 0) throw new Error("Division by zero");
        value /= divisor;
      } else {
        return value;
      }
    }
  };
  function expression(): number {
    let value = term();
    while (true) {
      skip();
      if (peek() === "+") {
        index += 1;
        value += term();
      } else if (peek() === "-") {
        index += 1;
        value -= term();
      } else {
        return value;
      }
    }
  }

  try {
    const value = expression();
    skip();
    if (index !== trimmed.length || !Number.isFinite(value)) return null;
    return { expression: trimmed, result: value };
  } catch {
    return null;
  }
}

export function publicRunError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/provider account|agent provider|missing provider|missing model|model is disabled|no longer available/i.test(message)) return message;
  if (/cancelled|canceled|timed out|timeout/i.test(message)) return message;
  return "Agent run failed. Check server logs or provider account settings for details.";
}

export function runFailureStatus(message: string): RunFailureStatus {
  if (/cancelled|canceled|aborted/i.test(message)) return "cancelled";
  if (/timed out|timeout/i.test(message)) return "timed_out";
  return "failed";
}

export function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new Error("Agent run cancelled");
}

export function timeoutSignal(timeoutMs: number, parent?: AbortSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timeout === "object" && "unref" in timeout && typeof timeout.unref === "function") timeout.unref();
  return {
    signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
    clear: () => clearTimeout(timeout)
  };
}

export function isBlockedAddress(address: string) {
  if (address.startsWith("127.") || address.startsWith("0.") || address.startsWith("10.") || address.startsWith("169.254.") || address.startsWith("192.168.")) return true;
  const ipv4Private = address.match(/^172\.(\d+)\./);
  if (ipv4Private && Number(ipv4Private[1]) >= 16 && Number(ipv4Private[1]) <= 31) return true;
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd");
}

// The SSRF guard. `resolveHost` is injected so the literal-address rules stay
// testable without DNS; a lookup that returns nothing is treated as blocked.
export async function isBlockedHost(hostname: string, resolveHost: (host: string) => Promise<string[]>) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) return true;
  const match = host.match(/^172\.(\d+)\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  if (isIP(host)) return isBlockedAddress(host);
  const addresses = await resolveHost(host);
  if (addresses.length === 0) return true;
  return addresses.some((address) => isBlockedAddress(address));
}

export function renderTemplate(template: string | undefined, values: Record<string, string>) {
  if (!template) return "";
  return Object.entries(values).reduce((next, [key, value]) => next.replaceAll(`{{${key}}}`, value), template);
}

export function enabledOpenApiActions(actions: AgentSpec["openApiActions"]) {
  return (actions ?? []).filter((item) => item.enabled !== false);
}

export function externalActionApprovalInput(spec: AgentSpec, inputText: string) {
  const openApiActions = enabledOpenApiActions(spec.openApiActions).map((action) => ({
    id: action.id ?? null,
    name: action.name ?? action.id ?? "OpenAPI action",
    method: (action.method || "GET").toUpperCase(),
    url: action.url ?? null
  }));
  const needsUrlFetchApproval = Boolean(spec.tools?.urlFetch && /https?:\/\//i.test(inputText));
  if (openApiActions.length === 0 && !needsUrlFetchApproval) return null;
  return {
    reason: "External network actions require approval before PacketChat executes them.",
    inputPreview: inputText.slice(0, 500),
    openApiActions,
    urlFetch: needsUrlFetchApproval
  };
}
