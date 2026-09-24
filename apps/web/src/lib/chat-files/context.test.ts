import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ATTACHMENT_LIMITS,
  attachmentInputsFromRows,
  buildAttachmentContext,
  type AttachmentInput,
  type StoredAttachmentText
} from "./context";

test("empty input yields an empty result", () => {
  const result = buildAttachmentContext([]);
  assert.equal(result.contextText, "");
  assert.deepEqual(result.included, []);
  assert.deepEqual(result.droppedFiles, []);
  assert.equal(result.totalChars, 0);
});

test("under-budget files pass through untruncated with headers", () => {
  const files: AttachmentInput[] = [
    { fileName: "a.txt", mimeType: "text/plain", text: "hello" },
    { fileName: "b.md", mimeType: "text/markdown", text: "world" }
  ];
  const result = buildAttachmentContext(files);

  assert.ok(result.contextText.includes("--- FILE: a.txt (text/plain) ---"));
  assert.ok(result.contextText.includes("--- FILE: b.md (text/markdown) ---"));
  assert.ok(result.contextText.includes("hello"));
  assert.ok(result.contextText.includes("world"));
  assert.deepEqual(result.included, [
    { fileName: "a.txt", chars: 5, truncated: false },
    { fileName: "b.md", chars: 5, truncated: false }
  ]);
  assert.deepEqual(result.droppedFiles, []);
  assert.equal(result.totalChars, result.contextText.length);
});

test("per-file text is clipped to perFileMaxChars and marked truncated", () => {
  const files: AttachmentInput[] = [
    { fileName: "big.txt", mimeType: "text/plain", text: "x".repeat(100) }
  ];
  const result = buildAttachmentContext(files, { perFileMaxChars: 10, totalMaxChars: 1000 });

  assert.deepEqual(result.included, [{ fileName: "big.txt", chars: 10, truncated: true }]);
  assert.ok(result.contextText.includes("x".repeat(10)));
  assert.ok(!result.contextText.includes("x".repeat(11)));
});

test("total budget drops later files which are still listed", () => {
  const files: AttachmentInput[] = [
    { fileName: "first.txt", mimeType: "text/plain", text: "a".repeat(30) },
    { fileName: "second.txt", mimeType: "text/plain", text: "b".repeat(30) },
    { fileName: "third.txt", mimeType: "text/plain", text: "c".repeat(30) }
  ];
  // First block (header + 30 chars) fits; adding the second would exceed the total budget.
  const result = buildAttachmentContext(files, { perFileMaxChars: 100, totalMaxChars: 100 });

  assert.deepEqual(result.included.map((f) => f.fileName), ["first.txt"]);
  assert.deepEqual(result.droppedFiles, ["second.txt", "third.txt"]);
  assert.ok(result.contextText.includes("first.txt"));
  assert.ok(!result.contextText.includes("second.txt"));
  assert.equal(result.totalChars, result.contextText.length);
});

test("default limits expose the documented budgets", () => {
  assert.deepEqual(DEFAULT_ATTACHMENT_LIMITS, { perFileMaxChars: 12000, totalMaxChars: 40000 });
});

test("stored attachments without extracted text are skipped from context", () => {
  const rows: StoredAttachmentText[] = [
    { id: "a", fileName: "ready.txt", mimeType: "text/plain", extractedText: "hello" },
    { id: "b", fileName: "empty.txt", mimeType: "text/plain", extractedText: "   " },
    { id: "c", fileName: "binary.bin", mimeType: null, extractedText: null },
    { id: "d", fileName: "md.md", mimeType: "text/markdown", extractedText: "world" }
  ];

  assert.deepEqual(attachmentInputsFromRows(rows), [
    { fileName: "ready.txt", mimeType: "text/plain", text: "hello" },
    { fileName: "md.md", mimeType: "text/markdown", text: "world" }
  ]);
});

test("stored attachment rows without a mime type fall back to text/plain", () => {
  const rows: StoredAttachmentText[] = [
    { id: "a", fileName: "notes", mimeType: null, extractedText: "body" }
  ];

  assert.deepEqual(attachmentInputsFromRows(rows), [
    { fileName: "notes", mimeType: "text/plain", text: "body" }
  ]);
});

test("attachment rows shape into bounded context end to end", () => {
  const rows: StoredAttachmentText[] = [
    { id: "a", fileName: "big.txt", mimeType: "text/plain", extractedText: "x".repeat(100) },
    { id: "b", fileName: "skipped.pdf", mimeType: "application/pdf", extractedText: null }
  ];

  const result = buildAttachmentContext(attachmentInputsFromRows(rows), { perFileMaxChars: 10, totalMaxChars: 1000 });

  assert.deepEqual(result.included, [{ fileName: "big.txt", chars: 10, truncated: true }]);
  assert.deepEqual(result.droppedFiles, []);
  assert.ok(result.contextText.includes("--- FILE: big.txt (text/plain) ---"));
  assert.ok(!result.contextText.includes("skipped.pdf"));
});
