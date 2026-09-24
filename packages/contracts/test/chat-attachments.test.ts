import assert from "node:assert/strict";
import { test } from "node:test";
import { chatRequestControlsSchema } from "../src/index";

const attachmentId = "11111111-1111-4111-8111-111111111111";

test("chat controls accept attachmentIds alongside the existing controls", () => {
  const parsed = chatRequestControlsSchema.safeParse({
    conversationId: "conv-1",
    parentMessageId: null,
    attachmentIds: [attachmentId]
  });

  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.success ? parsed.data.attachmentIds : undefined, [attachmentId]);
});

test("attachmentIds is optional", () => {
  const parsed = chatRequestControlsSchema.safeParse({});
  assert.equal(parsed.success, true);
  assert.equal(parsed.success ? parsed.data.attachmentIds : "missing", undefined);
});

test("attachmentIds must be UUIDs", () => {
  const parsed = chatRequestControlsSchema.safeParse({ attachmentIds: ["not-a-uuid"] });
  assert.equal(parsed.success, false);
});

test("attachmentIds is capped at 20 entries", () => {
  const parsed = chatRequestControlsSchema.safeParse({
    attachmentIds: Array.from({ length: 21 }, (_, index) => `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`)
  });
  assert.equal(parsed.success, false);
});
