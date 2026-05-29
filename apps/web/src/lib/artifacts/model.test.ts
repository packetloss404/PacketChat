import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { contentHash, toArtifactRecords, type ArtifactRecord } from "./model";
import type { ParsedArtifact } from "./parse";

test("toArtifactRecords maps every field", () => {
  const parsed: ParsedArtifact[] = [
    { identifier: "doc-1", type: "markdown", title: "Hello", content: "# Hi" }
  ];

  const [record] = toArtifactRecords(parsed, {
    ownerUserId: "user-1",
    conversationId: "conv-1",
    agentRunId: "run-1"
  });

  const expected: ArtifactRecord = {
    ownerUserId: "user-1",
    conversationId: "conv-1",
    agentRunId: "run-1",
    identifier: "doc-1",
    type: "markdown",
    title: "Hello",
    contentHash: createHash("sha256").update("# Hi", "utf8").digest("hex"),
    content: "# Hi"
  };

  assert.deepEqual(record, expected);
});

test("toArtifactRecords applies null defaults for absent title and context", () => {
  const parsed: ParsedArtifact[] = [
    { identifier: "doc-1", type: "code", content: "const x = 1;" }
  ];

  const [record] = toArtifactRecords(parsed, { ownerUserId: "user-1" });

  assert.equal(record.title, null);
  assert.equal(record.conversationId, null);
  assert.equal(record.agentRunId, null);
  assert.equal(record.ownerUserId, "user-1");
});

test("contentHash is a stable hex sha256 for identical content", () => {
  const a = contentHash("same content");
  const b = contentHash("same content");

  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(contentHash("same content"), contentHash("other content"));
});

test("toArtifactRecords dedupes by identifier keeping the last occurrence", () => {
  const parsed: ParsedArtifact[] = [
    { identifier: "doc-1", type: "markdown", title: "First", content: "first" },
    { identifier: "doc-2", type: "code", content: "two" },
    { identifier: "doc-1", type: "markdown", title: "Second", content: "second" }
  ];

  const records = toArtifactRecords(parsed, { ownerUserId: "user-1" });

  assert.equal(records.length, 2);

  const doc1 = records.find((r) => r.identifier === "doc-1");
  assert.ok(doc1);
  assert.equal(doc1.title, "Second");
  assert.equal(doc1.content, "second");
  assert.equal(doc1.contentHash, contentHash("second"));

  // First-seen position is preserved; only the value is replaced.
  assert.deepEqual(
    records.map((r) => r.identifier),
    ["doc-1", "doc-2"]
  );
});
