import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldRecordRunOutcome } from "../src/deps";

test("a waiting-input notice does not suppress the final approval-resume answer", () => {
  assert.equal(shouldRecordRunOutcome(["waiting_input"], "completed"), true);
});

test("retries do not write the same run outcome twice", () => {
  assert.equal(shouldRecordRunOutcome(["completed"], "completed"), false);
  assert.equal(shouldRecordRunOutcome(["waiting_input"], "waiting_input"), false);
});

test("the first terminal outcome wins a cancellation/completion race", () => {
  assert.equal(shouldRecordRunOutcome(["cancelled"], "completed"), false);
  assert.equal(shouldRecordRunOutcome(["completed"], "cancelled"), false);
});
