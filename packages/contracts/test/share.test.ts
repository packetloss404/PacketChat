import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildShareUrl,
  buildSharedConversation,
  generateShareToken,
  normalizeShareToken,
  toConversationShare,
  type ConversationShareRow
} from "../src/share";
import type { ChatTreeMessage } from "../src/chat-tree";

test("generateShareToken emits URL-safe tokens that normalize and never repeat", () => {
  const tokens = new Set<string>();
  for (let index = 0; index < 200; index += 1) {
    const token = generateShareToken();
    assert.equal(normalizeShareToken(token), token, "a generated token must be valid");
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.ok(token.length >= 32 && token.length <= 64);
    tokens.add(token);
  }
  assert.equal(tokens.size, 200, "tokens must not collide");
});

test("normalizeShareToken trims valid input and rejects malformed values", () => {
  const token = generateShareToken();
  assert.equal(normalizeShareToken(`  ${token}\n`), token);
  assert.equal(normalizeShareToken(undefined), null);
  assert.equal(normalizeShareToken(""), null);
  assert.equal(normalizeShareToken("short"), null);
  assert.equal(normalizeShareToken("has spaces ".repeat(4).trim()), null);
  assert.equal(normalizeShareToken(`${"a".repeat(31)}!`), null);
});

test("buildShareUrl joins the app base URL and token without doubling slashes", () => {
  const token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  assert.equal(buildShareUrl("https://chat.example.com", token), `https://chat.example.com/share/${token}`);
  assert.equal(buildShareUrl("https://chat.example.com/", token), `https://chat.example.com/share/${token}`);
});

test("toConversationShare maps the row and derives the absolute URL and revoked flag", () => {
  const row: ConversationShareRow = {
    id: "share-1",
    conversation_id: "conversation-1",
    token: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    active_leaf_message_id: "leaf-1",
    created_at: new Date("2026-01-02T03:04:05.000Z"),
    revoked_at: null
  };

  const share = toConversationShare(row, "https://chat.example.com/");
  assert.deepEqual(share, {
    id: "share-1",
    conversationId: "conversation-1",
    token: row.token,
    activeLeafMessageId: "leaf-1",
    createdAt: "2026-01-02T03:04:05.000Z",
    revokedAt: null,
    revoked: false,
    url: `https://chat.example.com/share/${row.token}`
  });

  const revoked = toConversationShare({ ...row, revoked_at: "2026-02-02T00:00:00.000Z" }, "https://chat.example.com");
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.revokedAt, "2026-02-02T00:00:00.000Z");
});

test("buildSharedConversation exposes only role, content and timestamps on the active path", () => {
  const messages: ChatTreeMessage[] = [
    { id: "m1", role: "user", content: [{ type: "text", text: "hi" }], parentMessageId: null, createdAt: "2026-01-01T00:00:01.000Z" },
    { id: "m2", role: "assistant", content: [{ type: "text", text: "hello" }], parentMessageId: "m1", createdAt: "2026-01-01T00:00:02.000Z" },
    { id: "m3", role: "assistant", content: [{ type: "text", text: "other branch" }], parentMessageId: "m1", createdAt: "2026-01-01T00:00:03.000Z" }
  ];

  const shared = buildSharedConversation({ title: "Demo", activeLeafMessageId: "m2", messages });

  assert.ok(shared);
  assert.equal(shared.title, "Demo");
  assert.deepEqual(shared.messages, [
    { role: "user", content: "hi", createdAt: "2026-01-01T00:00:01.000Z" },
    { role: "assistant", content: "hello", createdAt: "2026-01-01T00:00:02.000Z" }
  ]);
  for (const message of shared.messages) {
    assert.deepEqual(Object.keys(message).sort(), ["content", "createdAt", "role"]);
  }
});

test("buildSharedConversation fails closed when the recorded snapshot leaf no longer exists", () => {
  const messages: ChatTreeMessage[] = [
    { id: "m1", role: "user", content: [{ type: "text", text: "first" }], parentMessageId: null, createdAt: "2026-01-01T00:00:01.000Z" },
    { id: "m2", role: "assistant", content: [{ type: "text", text: "second" }], parentMessageId: "m1", createdAt: "2026-01-01T00:00:02.000Z" }
  ];

  assert.equal(buildSharedConversation({ title: "Demo", activeLeafMessageId: "deleted-leaf", messages }), null);
});

test("buildSharedConversation falls back to the latest message only when the share recorded no leaf", () => {
  const messages: ChatTreeMessage[] = [
    { id: "m1", role: "user", content: [{ type: "text", text: "first" }], parentMessageId: null, createdAt: "2026-01-01T00:00:01.000Z" },
    { id: "m2", role: "assistant", content: [{ type: "text", text: "second" }], parentMessageId: "m1", createdAt: "2026-01-01T00:00:02.000Z" }
  ];

  const shared = buildSharedConversation({ title: "Demo", activeLeafMessageId: null, messages });
  assert.ok(shared);
  assert.deepEqual(shared.messages.map((message) => message.content), ["first", "second"]);
});
