import type { ParsedArtifact } from "./parse";

export type ArtifactKind = "html" | "mermaid" | "react" | "svg" | "unknown";

export const ALLOWED_ARTIFACT_TYPES: readonly string[] = [
  "text/html",
  "application/vnd.mermaid",
  "application/vnd.react",
  "image/svg+xml"
];

const TYPE_TO_KIND: Record<string, ArtifactKind> = {
  "text/html": "html",
  "application/vnd.mermaid": "mermaid",
  "application/vnd.react": "react",
  "image/svg+xml": "svg"
};

export const DEFAULT_MAX_BYTES = 64 * 1024;

// No script tokens: artifact frames are always script-free and same-origin-free.
const IFRAME_SANDBOX = "";
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:;";

export type SanitizeResult = {
  safe: boolean;
  sanitizedContent: string;
  warnings: string[];
  /** True when the content exceeded `maxBytes` and was UTF-8-safely truncated. */
  truncated: boolean;
  sandbox: { iframeSandbox: string; csp: string };
};

export function classifyArtifactType(type: string): { allowed: boolean; kind: ArtifactKind } {
  const normalized = normalizeType(type);
  const kind = TYPE_TO_KIND[normalized];
  if (kind) {
    return { allowed: true, kind };
  }
  return { allowed: false, kind: "unknown" };
}

function normalizeType(type: string): string {
  // Strip any media-type parameters (e.g. "; charset=utf-8") and normalize case/whitespace.
  return type.split(";")[0].trim().toLowerCase();
}

function sandbox(): { iframeSandbox: string; csp: string } {
  return { iframeSandbox: IFRAME_SANDBOX, csp: CSP };
}

// Decode HTML entity / numeric encodings within a scheme prefix so that
// obfuscated dangerous URLs (e.g. "java&#115;cript:", "java\tscript:") can be
// detected. Blocks javascript:, vbscript:, and script-capable data: URIs while
// still permitting inline raster-image data URIs (data:image/png, etc.).
function looksLikeDangerousScheme(value: string): boolean {
  // Strip leading whitespace and control chars, decode numeric/hex entities,
  // and collapse all whitespace before the first colon.
  let decoded = value
    // Decode decimal numeric character references.
    .replace(/&#(\d+);?/g, (_m, code: string) => safeFromCodePoint(parseInt(code, 10)))
    // Decode hex numeric character references.
    .replace(/&#x([0-9a-f]+);?/gi, (_m, code: string) => safeFromCodePoint(parseInt(code, 16)));
  // Remove all whitespace and NUL/control characters (common XSS obfuscation).
  decoded = decoded.replace(/[\x00-\x20]+/g, "");
  if (/^(?:javascript|vbscript):/i.test(decoded)) {
    return true;
  }
  if (/^data:/i.test(decoded)) {
    // Allow only raster image data URIs; block data:text/html, data:image/svg+xml, etc.
    return !/^data:image\/(?:png|jpe?g|gif|webp|bmp)[;,]/i.test(decoded);
  }
  return false;
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
    return "";
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

type StripState = { content: string; warnings: string[]; truncated: boolean };

function stripScriptTags(state: StripState): void {
  // Match <script ...>...</script> including broken/unclosed variants.
  // Case-insensitive, dot-matches-newline behavior via [\s\S].
  const closed = /<script\b[\s\S]*?<\/script\s*>/gi;
  let removed = 0;
  state.content = state.content.replace(closed, () => {
    removed += 1;
    return "";
  });
  // Remove any dangling/unclosed <script ...> (no closing tag) to EOF.
  const dangling = /<script\b[\s\S]*$/i;
  if (dangling.test(state.content)) {
    state.content = state.content.replace(dangling, "");
    removed += 1;
  }
  // Remove a stray closing </script> with no opener.
  const strayClose = /<\/script\s*>/gi;
  state.content = state.content.replace(strayClose, () => {
    removed += 1;
    return "";
  });
  if (removed > 0) {
    state.warnings.push(`Removed ${removed} <script> tag(s)`);
  }
}

function stripEventHandlers(state: StripState): void {
  // Match on*= event handler attributes. Tolerate whitespace within/around the
  // attribute name boundary, quoted or unquoted values.
  // Examples: onclick="x", on click = 'x', onload=x
  // Leading separator is whitespace OR "/", since HTML parsers accept a slash
  // between attributes (e.g. "<img/onerror=alert(1)>").
  const handler =
    /[\s/]on\s*[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s>]+)/gi;
  let removed = 0;
  state.content = state.content.replace(handler, () => {
    removed += 1;
    return "";
  });
  if (removed > 0) {
    state.warnings.push(`Removed ${removed} inline event handler attribute(s)`);
  }
}

function stripJavascriptUrls(state: StripState): void {
  // Match attribute values (href/src/xlink:href/etc.) whose value is a
  // javascript: scheme (including obfuscated encodings).
  let removed = 0;
  const attr = /(\s[a-z0-9:_-]+\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  state.content = state.content.replace(
    attr,
    (match, prefix: string, dq?: string, sq?: string, uq?: string) => {
      const raw = dq ?? sq ?? uq ?? "";
      if (looksLikeDangerousScheme(raw)) {
        removed += 1;
        // Replace the value with an empty quoted value, preserving attribute name.
        return `${prefix}""`;
      }
      return match;
    }
  );
  if (removed > 0) {
    state.warnings.push(`Removed ${removed} dangerous URL(s) (javascript:/data:/vbscript:)`);
  }
}

function stripForeignObject(state: StripState): void {
  const closed = /<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi;
  let removed = 0;
  state.content = state.content.replace(closed, () => {
    removed += 1;
    return "";
  });
  const dangling = /<foreignObject\b[\s\S]*$/i;
  if (dangling.test(state.content)) {
    state.content = state.content.replace(dangling, "");
    removed += 1;
  }
  const strayClose = /<\/foreignObject\s*>/gi;
  state.content = state.content.replace(strayClose, () => {
    removed += 1;
    return "";
  });
  if (removed > 0) {
    state.warnings.push(`Removed ${removed} <foreignObject> element(s)`);
  }
}

function enforceMaxBytes(state: StripState, maxBytes: number): void {
  const full = Buffer.from(state.content, "utf8");
  if (full.length <= maxBytes) {
    return;
  }
  // Truncate at maxBytes, then back up only if the cut point lands in the
  // middle of a multi-byte sequence: full[end] is the first dropped byte, so if
  // it is a continuation byte (10xxxxxx) we are mid-character and step back to
  // the sequence start. A complete sequence ending exactly at the boundary is
  // preserved.
  let end = maxBytes;
  while (end > 0 && (full[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  state.content = full.subarray(0, end).toString("utf8");
  state.truncated = true;
  state.warnings.push(`Content exceeded ${maxBytes} bytes and was truncated`);
}

export function sanitizeArtifact(
  artifact: ParsedArtifact,
  opts?: { maxBytes?: number }
): SanitizeResult {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const { allowed, kind } = classifyArtifactType(artifact.type);

  if (!allowed) {
    return {
      safe: false,
      sanitizedContent: "",
      warnings: [`Disallowed artifact type "${artifact.type}"; content blanked`],
      truncated: false,
      sandbox: sandbox()
    };
  }

  const state: StripState = { content: artifact.content, warnings: [], truncated: false };

  if (kind === "html" || kind === "svg") {
    // Run the strip passes to a fixpoint so a token reformed by one removal
    // (e.g. "<scr<script>ipt>") is caught on a subsequent pass.
    let previous: string;
    let iterations = 0;
    do {
      previous = state.content;
      stripScriptTags(state);
      stripEventHandlers(state);
      stripJavascriptUrls(state);
      if (kind === "svg") {
        stripForeignObject(state);
      }
      iterations += 1;
    } while (state.content !== previous && iterations < 5);
  }

  // mermaid/react are treated as inert data here; only size is enforced.
  enforceMaxBytes(state, maxBytes);

  return {
    safe: true,
    sanitizedContent: state.content,
    warnings: state.warnings,
    truncated: state.truncated,
    sandbox: sandbox()
  };
}
