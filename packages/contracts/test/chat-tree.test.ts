import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adjacentSibling,
  buildActivePath,
  contentToText,
  conversationExportFilename,
  findActiveLeaf,
  messageText,
  normalizeConversationSearch,
  parseConversationExportFormat,
  serializeConversationExport,
  siblingsOf,
  type ChatTreeMessage
} from "../src/index";

function tree(): ChatTreeMessage[] {
  return [
    { id: "m1", role: "user", text: "hi", parentMessageId: null, createdAt: "2024-01-01T00:00:01.000Z" },
    { id: "m2", role: "assistant", text: "hello", parentMessageId: "m1", createdAt: "2024-01-01T00:00:02.000Z" },
    { id: "m3", role: "user", text: "branch a", parentMessageId: "m2", createdAt: "2024-01-01T00:00:03.000Z" },
    { id: "m4", role: "assistant", text: "reply a", parentMessageId: "m3", createdAt: "2024-01-01T00:00:04.000Z" },
    { id: "m5", role: "user", text: "branch b", parentMessageId: "m2", createdAt: "2024-01-01T00:00:05.000Z" },
    { id: "m6", role: "assistant", text: "reply b", parentMessageId: "m5", createdAt: "2024-01-01T00:00:06.000Z" }
  ];
}

test("buildActivePath reconstructs the root-to-leaf path for the active branch", () => {
  const messages = tree();
  assert.deepEqual(buildActivePath(messages, "m6").map((message) => message.id), ["m1", "m2", "m5", "m6"]);
  assert.deepEqual(buildActivePath(messages, "m4").map((message) => message.id), ["m1", "m2", "m3", "m4"]);
});

test("buildActivePath falls back to the most recent message when the leaf is unknown", () => {
  const messages = tree();
  assert.deepEqual(buildActivePath(messages, "does-not-exist").map((message) => message.id), ["m1", "m2", "m5", "m6"]);
  assert.deepEqual(buildActivePath(messages, null).map((message) => message.id), ["m1", "m2", "m5", "m6"]);
});

test("findActiveLeaf prefers the recorded leaf and otherwise uses the latest created message", () => {
  const messages = tree();
  assert.equal(findActiveLeaf(messages, "m4")?.id, "m4");
  assert.equal(findActiveLeaf(messages, null)?.id, "m6");
});

test("buildActivePath terminates instead of looping when parents form a cycle", () => {
  const messages: ChatTreeMessage[] = [
    { id: "a", role: "user", text: "a", parentMessageId: "b", createdAt: "2024-01-01T00:00:01.000Z" },
    { id: "b", role: "assistant", text: "b", parentMessageId: "a", createdAt: "2024-01-01T00:00:02.000Z" }
  ];
  const path = buildActivePath(messages, "a");
  assert.equal(new Set(path.map((message) => message.id)).size, path.length);
  assert.ok(path.length <= messages.length);
});

test("buildActivePath returns all messages chronologically for a flat all-null conversation", () => {
  const messages: ChatTreeMessage[] = [
    { id: "f3", role: "assistant", text: "third", parentMessageId: null, createdAt: "2024-01-01T00:00:03.000Z" },
    { id: "f1", role: "user", text: "first", parentMessageId: null, createdAt: "2024-01-01T00:00:01.000Z" },
    { id: "f2", role: "assistant", text: "second", parentMessageId: null, createdAt: "2024-01-01T00:00:02.000Z" }
  ];
  assert.deepEqual(buildActivePath(messages, "f3").map((message) => message.id), ["f1", "f2", "f3"]);
  assert.deepEqual(buildActivePath(messages, null).map((message) => message.id), ["f1", "f2", "f3"]);
  // A stale or earlier leaf must not drop the messages that were written flat.
  assert.deepEqual(buildActivePath(messages, "f1").map((message) => message.id), ["f1", "f2", "f3"]);
});

test("buildActivePath prepends orphan legacy messages then the active parent-linked path", () => {
  const messages: ChatTreeMessage[] = [
    { id: "legacy2", role: "assistant", text: "old reply", parentMessageId: null, createdAt: "2024-01-01T00:00:02.000Z" },
    { id: "legacy1", role: "user", text: "old", parentMessageId: null, createdAt: "2024-01-01T00:00:01.000Z" },
    { id: "root", role: "user", text: "new", parentMessageId: null, createdAt: "2024-01-01T00:00:03.000Z" },
    { id: "child", role: "assistant", text: "new reply", parentMessageId: "root", createdAt: "2024-01-01T00:00:04.000Z" }
  ];
  assert.deepEqual(buildActivePath(messages, "child").map((message) => message.id), ["legacy1", "legacy2", "root", "child"]);
});

test("buildActivePath leaves a single-root normal tree unchanged", () => {
  const messages = tree();
  assert.deepEqual(buildActivePath(messages, "m6").map((message) => message.id), ["m1", "m2", "m5", "m6"]);
});

test("buildActivePath stays cycle-safe while still prepending an orphan legacy row", () => {
  const messages: ChatTreeMessage[] = [
    { id: "orphan", role: "user", text: "legacy", parentMessageId: null, createdAt: "2024-01-01T00:00:00.000Z" },
    { id: "a", role: "user", text: "a", parentMessageId: "b", createdAt: "2024-01-01T00:00:01.000Z" },
    { id: "b", role: "assistant", text: "b", parentMessageId: "a", createdAt: "2024-01-01T00:00:02.000Z" }
  ];
  const path = buildActivePath(messages, "a");
  assert.equal(path[0]?.id, "orphan");
  assert.deepEqual(new Set(path.slice(1).map((message) => message.id)), new Set(["a", "b"]));
  assert.equal(new Set(path.map((message) => message.id)).size, path.length);
});

test("siblingsOf and adjacentSibling navigate branches that share a parent", () => {
  const messages = tree();
  assert.deepEqual(siblingsOf(messages, "m3").map((message) => message.id), ["m3", "m5"]);
  assert.deepEqual(siblingsOf(messages, "m1").map((message) => message.id), ["m1"]);
  assert.equal(adjacentSibling(messages, "m3", 1)?.id, "m5");
  assert.equal(adjacentSibling(messages, "m5", -1)?.id, "m3");
  assert.equal(adjacentSibling(messages, "m5", 1), null);
});

test("normalizeConversationSearch trims and escapes ILIKE wildcards", () => {
  assert.deepEqual(normalizeConversationSearch("  hello  "), { hasSearch: true, pattern: "%hello%" });
  assert.deepEqual(normalizeConversationSearch("50%_off\\"), { hasSearch: true, pattern: "%50\\%\\_off\\\\%" });
  assert.deepEqual(normalizeConversationSearch("   "), { hasSearch: false, pattern: "" });
  assert.deepEqual(normalizeConversationSearch(undefined), { hasSearch: false, pattern: "" });
});

test("parseConversationExportFormat defaults to markdown and rejects unknown values", () => {
  assert.equal(parseConversationExportFormat(undefined), "md");
  assert.equal(parseConversationExportFormat(""), "md");
  assert.equal(parseConversationExportFormat("markdown"), "md");
  assert.equal(parseConversationExportFormat("json"), "json");
  assert.equal(parseConversationExportFormat("text"), "txt");
  assert.equal(parseConversationExportFormat("pdf"), null);
});

test("contentToText and messageText derive plain text from stored content parts", () => {
  assert.equal(contentToText([{ type: "text", text: "one" }, { type: "text", text: "two" }]), "one\ntwo");
  assert.equal(contentToText("plain"), "plain");
  assert.equal(contentToText(null), "");
  assert.equal(messageText({ text: "cached", content: [{ type: "text", text: "ignored" }] }), "cached");
  assert.equal(messageText({ content: [{ type: "text", text: "derived" }] }), "derived");
});

test("serializeConversationExport writes markdown, text and json for the active path", () => {
  const messages = buildActivePath(tree(), "m6").slice(0, 2);
  const base = { conversationId: "11111111-2222-3333-4444-555555555555", title: "Demo Chat", messages };

  assert.equal(serializeConversationExport({ ...base, format: "md" }), "# Demo Chat\n\n**User:** hi\n\n**Assistant:** hello\n");
  assert.equal(serializeConversationExport({ ...base, format: "txt" }), "Demo Chat\n\nUser: hi\n\nAssistant: hello\n");

  const parsed = JSON.parse(serializeConversationExport({ ...base, format: "json" })) as {
    conversation: { id: string; title: string };
    messages: Array<{ id: string; role: string; content: string; parentMessageId: string | null }>;
  };
  assert.equal(parsed.conversation.title, "Demo Chat");
  assert.equal(parsed.messages.length, 2);
  assert.deepEqual(parsed.messages[0], {
    id: "m1",
    role: "user",
    content: "hi",
    parentMessageId: null,
    createdAt: "2024-01-01T00:00:01.000Z"
  });
});

test("conversationExportFilename slugifies the title and keeps the right extension", () => {
  assert.equal(conversationExportFilename("My Chat: Hello!", "abcdef12-3456-7890-0000-000000000000", "json"), "my-chat-hello-abcdef12.json");
  assert.equal(conversationExportFilename("", "abcdef12-3456-7890-0000-000000000000", "md"), "conversation-abcdef12.md");
  assert.equal(conversationExportFilename("Notes", "abcdef12-3456-7890-0000-000000000000", "txt"), "notes-abcdef12.txt");
});
