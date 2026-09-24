import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALLOWED_ARTIFACT_TYPES,
  classifyArtifactType,
  sanitizeArtifact
} from "./sanitize";
import type { ParsedArtifact } from "./parse";

function artifact(partial: Partial<ParsedArtifact> & { type: string; content: string }): ParsedArtifact {
  return {
    identifier: partial.identifier ?? "a1",
    title: partial.title,
    type: partial.type,
    content: partial.content
  };
}

const SANDBOX = "";
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:;";

test("ALLOWED_ARTIFACT_TYPES lists exactly the supported media types", () => {
  assert.deepEqual([...ALLOWED_ARTIFACT_TYPES], [
    "text/html",
    "application/vnd.mermaid",
    "application/vnd.react",
    "image/svg+xml"
  ]);
});

test("classifyArtifactType maps allowed types and rejects unknowns", () => {
  assert.deepEqual(classifyArtifactType("text/html"), { allowed: true, kind: "html" });
  assert.deepEqual(classifyArtifactType("image/svg+xml"), { allowed: true, kind: "svg" });
  assert.deepEqual(classifyArtifactType("application/vnd.mermaid"), { allowed: true, kind: "mermaid" });
  assert.deepEqual(classifyArtifactType("application/vnd.react"), { allowed: true, kind: "react" });
  // Case-insensitive and parameter-tolerant.
  assert.deepEqual(classifyArtifactType("TEXT/HTML; charset=utf-8"), { allowed: true, kind: "html" });
  assert.deepEqual(classifyArtifactType("application/javascript"), { allowed: false, kind: "unknown" });
});

test("disallowed type is blanked and marked unsafe", () => {
  const result = sanitizeArtifact(artifact({ type: "application/javascript", content: "alert(1)" }));
  assert.equal(result.safe, false);
  assert.equal(result.sanitizedContent, "");
  assert.equal(result.warnings.length >= 1, true);
  assert.equal(result.sandbox.iframeSandbox, SANDBOX);
  assert.equal(result.sandbox.csp, CSP);
});

test("strips script tags including nested, broken, and mixed-case variants", () => {
  const content =
    "<div>ok</div>" +
    "<SCRIPT>alert(1)</SCRIPT>" +
    "<script type='text/javascript'>evil()</script>" +
    "<script>unclosed";
  const result = sanitizeArtifact(artifact({ type: "text/html", content }));
  assert.equal(result.safe, true);
  assert.equal(/script/i.test(result.sanitizedContent), false);
  assert.equal(result.sanitizedContent.includes("<div>ok</div>"), true);
  assert.equal(result.warnings.some((w) => /script/i.test(w)), true);
});

test("strips on* event handler attributes (quoted, unquoted, mixed case, spaced)", () => {
  const content =
    "<img src=\"x\" onerror=\"alert(1)\">" +
    "<body ONLOAD='steal()'>" +
    "<a onclick=go>x</a>";
  const result = sanitizeArtifact(artifact({ type: "text/html", content }));
  assert.equal(result.safe, true);
  assert.equal(/\son\w+\s*=/i.test(result.sanitizedContent), false);
  assert.equal(result.sanitizedContent.includes("src=\"x\""), true);
  assert.equal(result.warnings.some((w) => /event handler/i.test(w)), true);
});

test("strips javascript: URLs including encoded and whitespace-obfuscated schemes", () => {
  const content =
    "<a href=\"javascript:alert(1)\">a</a>" +
    "<a href='JAVASCRIPT:evil()'>b</a>" +
    "<a href=\"java&#115;cript:hi()\">c</a>" +
    "<a href=\"&#x6a;avascript:hi()\">d</a>";
  const result = sanitizeArtifact(artifact({ type: "text/html", content }));
  assert.equal(result.safe, true);
  assert.equal(/javascript:/i.test(result.sanitizedContent), false);
  // Encoded variants should also be neutralized.
  assert.equal(result.sanitizedContent.includes("&#115;cript:"), false);
  assert.equal(result.warnings.some((w) => /javascript:/i.test(w)), true);
});

test("safe HTML with allowed attributes passes through unchanged", () => {
  const content = "<div class=\"box\"><p>Hello <strong>world</strong></p><img src=\"data:image/png;base64,AAAA\"></div>";
  const result = sanitizeArtifact(artifact({ type: "text/html", content }));
  assert.equal(result.safe, true);
  assert.equal(result.sanitizedContent, content);
  assert.deepEqual(result.warnings, []);
});

test("safe SVG passes through but foreignObject and scripts are removed", () => {
  const safe = "<svg xmlns=\"http://www.w3.org/2000/svg\"><circle cx=\"5\" cy=\"5\" r=\"4\"/></svg>";
  const safeResult = sanitizeArtifact(artifact({ type: "image/svg+xml", content: safe }));
  assert.equal(safeResult.safe, true);
  assert.equal(safeResult.sanitizedContent, safe);
  assert.deepEqual(safeResult.warnings, []);

  const unsafe =
    "<svg><foreignObject><body onload=\"x\"></body></foreignObject><script>a()</script></svg>";
  const unsafeResult = sanitizeArtifact(artifact({ type: "image/svg+xml", content: unsafe }));
  assert.equal(unsafeResult.safe, true);
  assert.equal(/foreignObject/i.test(unsafeResult.sanitizedContent), false);
  assert.equal(/script/i.test(unsafeResult.sanitizedContent), false);
  assert.equal(unsafeResult.warnings.some((w) => /foreignObject/i.test(w)), true);
});

test("oversize content is truncated with a warning while staying safe", () => {
  const content = "a".repeat(100);
  const result = sanitizeArtifact(artifact({ type: "application/vnd.mermaid", content }), { maxBytes: 10 });
  assert.equal(result.safe, true);
  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.sanitizedContent, "utf8") <= 10, true);
  assert.equal(result.warnings.some((w) => /truncat/i.test(w)), true);
});

test("mermaid and react content is passed through as inert data", () => {
  const mermaid = "graph TD; A-->B; <script>nope</script>";
  const result = sanitizeArtifact(artifact({ type: "application/vnd.mermaid", content: mermaid }));
  assert.equal(result.safe, true);
  // mermaid is data, not executed, so script-like text is preserved verbatim.
  assert.equal(result.sanitizedContent, mermaid);
  assert.deepEqual(result.warnings, []);
});

test("sandbox never grants scripts or same-origin", () => {
  const result = sanitizeArtifact(artifact({ type: "text/html", content: "<p>x</p>" }));
  assert.equal(result.sandbox.iframeSandbox.includes("allow-same-origin"), false);
  assert.equal(result.sandbox.iframeSandbox.includes("allow-scripts"), false);
  assert.equal(result.sandbox.iframeSandbox, "");
  assert.equal(result.sandbox.csp, CSP);
});

test("strips slash-separated event handlers (<img/onerror=...>)", () => {
  const content = "<img/onerror=alert(1) src=x><svg/onload=alert(1)>";
  const result = sanitizeArtifact(artifact({ type: "text/html", content }));
  assert.equal(result.safe, true);
  assert.equal(/onerror|onload/i.test(result.sanitizedContent), false);
  assert.equal(result.warnings.some((w) => /event handler/i.test(w)), true);
});

test("blocks script-capable data: URLs but allows raster image data URIs", () => {
  const unsafe = "<a href=\"data:text/html,<script>alert(1)</script>\">x</a>";
  const unsafeResult = sanitizeArtifact(artifact({ type: "text/html", content: unsafe }));
  assert.equal(unsafeResult.safe, true);
  assert.equal(unsafeResult.sanitizedContent.includes("data:text/html"), false);
  assert.equal(unsafeResult.warnings.some((w) => /javascript:/i.test(w)), true);

  const image = "<img src=\"data:image/png;base64,AAAA\">";
  const imageResult = sanitizeArtifact(artifact({ type: "text/html", content: image }));
  assert.equal(imageResult.sanitizedContent, image);
  assert.deepEqual(imageResult.warnings, []);
});

test("blocks vbscript: URLs", () => {
  const content = "<a href=\"vbscript:msgbox(1)\">x</a>";
  const result = sanitizeArtifact(artifact({ type: "text/html", content }));
  assert.equal(/vbscript:/i.test(result.sanitizedContent), false);
});
