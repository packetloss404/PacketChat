import { parseArtifacts, type ParsedArtifact } from "./parse";
import { DEFAULT_MAX_BYTES, classifyArtifactType, sanitizeArtifact, type ArtifactKind } from "./sanitize";

/**
 * How an artifact should be surfaced. `iframe` and `code` come straight from the
 * sanitizer's classification; `markdown` is handled here because markdown is a
 * safe React-rendered format that never touches the HTML sanitizer; `unsupported`
 * means the type is not allowed and the content was blanked by the sanitizer.
 */
export type ArtifactPresentation = "iframe" | "markdown" | "code" | "unsupported";

export type ArtifactViewModel = {
  identifier: string;
  /** Original media type from the fence, e.g. "text/html". */
  type: string;
  kind: ArtifactKind | "markdown";
  title: string;
  /** Sanitized (and possibly truncated) content, safe to render. */
  content: string;
  presentation: ArtifactPresentation;
  safe: boolean;
  warnings: string[];
  truncated: boolean;
  /** Sandbox tokens safe to pass to an iframe; never scripts/same-origin. */
  iframeSandbox: string;
  /** Content-Security-Policy applied inside the sandboxed document. */
  csp: string;
};

export type ArtifactMessageView = {
  /** Message text with all artifact fences removed. */
  prose: string;
  artifacts: ArtifactViewModel[];
  malformed: number;
};

const MARKDOWN_TYPES = new Set(["text/markdown", "text/x-markdown", "markdown"]);

const FALLBACK_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:;";

export function isMarkdownArtifactType(type: string): boolean {
  return MARKDOWN_TYPES.has(type.split(";")[0].trim().toLowerCase());
}

/**
 * Tokens that are safe to pass through to the frame. This is an explicit
 * allowlist, not a denylist: anything not vetted here (including
 * `allow-scripts`, `allow-same-origin`, `allow-top-navigation`, `allow-popups`
 * and unknown/future tokens) is dropped. The sanitizer only ever emits `""`
 * today, so this is defense in depth if a raw token ever reaches us.
 */
const SAFE_IFRAME_SANDBOX_TOKENS: ReadonlySet<string> = new Set([
  "allow-forms",
  "allow-modals",
  "allow-orientation-lock",
  "allow-pointer-lock",
  "allow-presentation"
]);

/**
 * Intersects the sanitizer's sandbox tokens with the strict allowlist above.
 * This can only ever tighten the sandbox: scripts, same-origin, popups and
 * top-level navigation can never pass, so HTML/SVG artifacts render in an
 * opaque, script-free frame.
 */
export function safeIframeSandbox(raw: string): string {
  return raw
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => SAFE_IFRAME_SANDBOX_TOKENS.has(part))
    .join(" ");
}

/**
 * UTF-8 byte truncation that never splits a multi-byte code point. Mirrors the
 * sanitizer's boundary behavior but stays browser-friendly (no Buffer).
 */
export function truncateUtf8(value: string, maxBytes: number): { content: string; truncated: boolean } {
  if (maxBytes <= 0) return { content: "", truncated: value.length > 0 };
  const encoded = new TextEncoder().encode(value);
  if (encoded.length <= maxBytes) return { content: value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return { content: new TextDecoder().decode(encoded.subarray(0, end)), truncated: true };
}

export function artifactKindLabel(kind: ArtifactKind | "markdown"): string {
  switch (kind) {
    case "html":
      return "HTML";
    case "svg":
      return "SVG";
    case "mermaid":
      return "Mermaid";
    case "react":
      return "React";
    case "markdown":
      return "Markdown";
    default:
      return "Unsupported";
  }
}

export function toArtifactViewModel(
  artifact: ParsedArtifact,
  opts?: { maxBytes?: number }
): ArtifactViewModel {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const title = artifact.title?.trim() || artifact.identifier;

  if (isMarkdownArtifactType(artifact.type)) {
    const { content, truncated } = truncateUtf8(artifact.content, maxBytes);
    return {
      identifier: artifact.identifier,
      type: artifact.type,
      kind: "markdown",
      title,
      content,
      presentation: "markdown",
      safe: true,
      warnings: truncated ? [`Content exceeded ${maxBytes} bytes and was truncated`] : [],
      truncated,
      iframeSandbox: "",
      csp: FALLBACK_CSP
    };
  }

  const result = sanitizeArtifact(artifact, { maxBytes });
  const { kind } = classifyArtifactType(artifact.type);
  const presentation: ArtifactPresentation = !result.safe
    ? "unsupported"
    : kind === "html" || kind === "svg"
      ? "iframe"
      : kind === "mermaid" || kind === "react"
        ? "code"
        : "unsupported";

  return {
    identifier: artifact.identifier,
    type: artifact.type,
    kind,
    title,
    content: result.sanitizedContent,
    presentation,
    safe: result.safe,
    warnings: result.warnings,
    truncated: result.truncated,
    iframeSandbox: safeIframeSandbox(result.sandbox.iframeSandbox),
    csp: result.sandbox.csp || FALLBACK_CSP
  };
}

/**
 * Pure split of an assistant message into prose + artifact view models. The
 * artifact fences are removed from `prose` (via `parseArtifacts`) so the raw
 * source is never rendered twice.
 */
export function buildArtifactMessageView(
  text: string,
  opts?: { maxBytes?: number }
): ArtifactMessageView {
  const { artifacts, strippedText, malformed } = parseArtifacts(text);
  return {
    prose: strippedText,
    malformed,
    artifacts: artifacts.map((artifact) => toArtifactViewModel(artifact, opts))
  };
}

function escapeCsp(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Builds a complete, standalone document for `srcDoc`. The CSP comes from the
 * sanitizer, and only ever tightens it; the document is still rendered inside a
 * script-free, same-origin-free iframe.
 */
export function buildSandboxedDocument(view: ArtifactViewModel): string {
  const csp = view.csp || FALLBACK_CSP;
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeCsp(csp)}">`,
    '<meta name="color-scheme" content="light dark">',
    "<style>html,body{margin:0;padding:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;}img,svg{max-width:100%;height:auto;}</style>",
    `</head><body>${view.content}</body></html>`
  ].join("");
}
