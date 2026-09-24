import assert from "node:assert/strict";
import { test } from "node:test";
import {
  artifactKindLabel,
  buildArtifactMessageView,
  buildSandboxedDocument,
  isMarkdownArtifactType,
  safeIframeSandbox,
  toArtifactViewModel,
  truncateUtf8
} from "./view-model";
import type { ParsedArtifact } from "./parse";

function artifact(partial: Partial<ParsedArtifact> & { type: string; content: string }): ParsedArtifact {
  return {
    identifier: partial.identifier ?? "a1",
    title: partial.title,
    type: partial.type,
    content: partial.content
  };
}

test("buildArtifactMessageView splits prose from artifacts and strips fences", () => {
  const text = [
    "Here is a page:",
    ':::artifact{identifier="page-1" type="text/html" title="Landing"}',
    "<p>hello</p>",
    ":::",
    "Enjoy."
  ].join("\n");

  const view = buildArtifactMessageView(text);

  assert.equal(view.malformed, 0);
  assert.equal(view.prose, "Here is a page:\nEnjoy.");
  assert.equal(view.prose.includes(":::artifact"), false);
  assert.equal(view.artifacts.length, 1);
  assert.equal(view.artifacts[0].identifier, "page-1");
  assert.equal(view.artifacts[0].title, "Landing");
  assert.equal(view.artifacts[0].presentation, "iframe");
});

test("html artifacts render in a script-free, same-origin-free iframe", () => {
  const view = toArtifactViewModel(
    artifact({ type: "text/html", content: "<div>ok</div><script>evil()</script>" })
  );

  assert.equal(view.presentation, "iframe");
  assert.equal(view.safe, true);
  assert.equal(view.iframeSandbox, "");
  assert.equal(view.iframeSandbox.includes("allow-scripts"), false);
  assert.equal(view.iframeSandbox.includes("allow-same-origin"), false);
  assert.equal(/script/i.test(view.content), false);
  assert.equal(view.content.includes("<div>ok</div>"), true);
});

test("svg artifacts render in the same sandboxed iframe presentation", () => {
  const view = toArtifactViewModel(
    artifact({ type: "image/svg+xml", content: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>' })
  );
  assert.equal(view.presentation, "iframe");
  assert.equal(view.iframeSandbox, "");
});

test("mermaid and react artifacts stay inert code and preserve content verbatim", () => {
  const mermaid = "graph TD; A-->B; <script>nope</script>";
  const mermaidView = toArtifactViewModel(artifact({ type: "application/vnd.mermaid", content: mermaid }));
  assert.equal(mermaidView.presentation, "code");
  assert.equal(mermaidView.kind, "mermaid");
  assert.equal(mermaidView.content, mermaid);

  const reactView = toArtifactViewModel(
    artifact({ type: "application/vnd.react", content: "export default function App(){return null;}" })
  );
  assert.equal(reactView.presentation, "code");
  assert.equal(reactView.kind, "react");
});

test("markdown artifacts render as markdown without the HTML sanitizer", () => {
  const view = toArtifactViewModel(artifact({ type: "text/markdown", content: "# Title\n\nBody" }));
  assert.equal(view.kind, "markdown");
  assert.equal(view.presentation, "markdown");
  assert.equal(view.safe, true);
  assert.equal(view.content, "# Title\n\nBody");
  assert.equal(isMarkdownArtifactType("TEXT/MARKDOWN; charset=utf-8"), true);
  assert.equal(isMarkdownArtifactType("text/html"), false);
});

test("disallowed artifact types are blanked and marked unsupported", () => {
  const view = toArtifactViewModel(artifact({ type: "application/javascript", content: "alert(1)" }));
  assert.equal(view.presentation, "unsupported");
  assert.equal(view.safe, false);
  assert.equal(view.content, "");
  assert.equal(view.warnings.length >= 1, true);
});

test("oversize content is truncated at the sanitizer limit for both paths", () => {
  const html = toArtifactViewModel(
    artifact({ type: "text/html", content: `<p>${"a".repeat(100)}</p>` }),
    { maxBytes: 10 }
  );
  assert.equal(html.truncated, true);
  assert.equal(html.warnings.some((w) => /truncat/i.test(w)), true);

  const markdown = toArtifactViewModel(
    artifact({ type: "text/markdown", content: "a".repeat(100) }),
    { maxBytes: 10 }
  );
  assert.equal(markdown.truncated, true);
  assert.equal(markdown.content.length, 10);
});

test("truncateUtf8 never splits a multi-byte code point", () => {
  // "é" is two UTF-8 bytes; a 3-byte budget must not emit a replacement char.
  const { content, truncated } = truncateUtf8("éé", 3);
  assert.equal(truncated, true);
  assert.equal(content, "é");
  assert.equal(content.includes("\uFFFD"), false);
});

test("safeIframeSandbox only passes vetted allowlist tokens", () => {
  assert.equal(safeIframeSandbox("allow-scripts"), "");
  assert.equal(safeIframeSandbox("allow-scripts allow-same-origin"), "");
  assert.equal(safeIframeSandbox("allow-top-navigation"), "");
  assert.equal(safeIframeSandbox("allow-popups"), "");
  assert.equal(safeIframeSandbox("allow-popups-to-escape-sandbox"), "");
  assert.equal(safeIframeSandbox("allow-forms"), "allow-forms");
  assert.equal(
    safeIframeSandbox("allow-scripts allow-forms allow-same-origin"),
    "allow-forms"
  );
  assert.equal(safeIframeSandbox("allow-forms allow-popups allow-top-navigation"), "allow-forms");
});

test("buildSandboxedDocument wraps content with the sanitizer CSP", () => {
  const view = toArtifactViewModel(artifact({ type: "text/html", content: "<p>hi</p>" }));
  const doc = buildSandboxedDocument(view);
  assert.equal(doc.includes("Content-Security-Policy"), true);
  assert.equal(doc.includes("default-src 'none'"), true);
  assert.equal(doc.includes("<p>hi</p>"), true);
  assert.equal(doc.startsWith("<!doctype html>"), true);
});

test("artifactKindLabel covers every kind", () => {
  assert.equal(artifactKindLabel("html"), "HTML");
  assert.equal(artifactKindLabel("svg"), "SVG");
  assert.equal(artifactKindLabel("mermaid"), "Mermaid");
  assert.equal(artifactKindLabel("react"), "React");
  assert.equal(artifactKindLabel("markdown"), "Markdown");
  assert.equal(artifactKindLabel("unknown"), "Unsupported");
});
