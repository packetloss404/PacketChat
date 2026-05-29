import assert from "node:assert/strict";
import { test } from "node:test";
import {
  StepSequencer,
  makeToolCallStep,
  makeToolResultStep,
  pairCallsWithResults,
  type ToolCall,
  type ToolResult
} from "./tool-steps";

test("step sequencer increases monotonically from default start", () => {
  const seq = new StepSequencer();
  assert.equal(seq.current(), 1);
  assert.equal(seq.next(), 1);
  assert.equal(seq.next(), 2);
  assert.equal(seq.next(), 3);
  assert.equal(seq.current(), 4);
});

test("step sequencer honors a custom start offset", () => {
  const seq = new StepSequencer(10);
  assert.equal(seq.current(), 10);
  assert.equal(seq.next(), 10);
  assert.equal(seq.next(), 11);
});

test("makeToolCallStep maps fields and marks the step running", () => {
  const seq = new StepSequencer(5);
  const call: ToolCall = { id: "c1", name: "search", arguments: { q: "hi" } };
  const step = makeToolCallStep(seq, call);

  assert.deepEqual(step, {
    sequenceNo: 5,
    stepType: "tool_call",
    status: "running",
    name: "search",
    input: call
  });
});

test("makeToolResultStep marks ok results completed", () => {
  const seq = new StepSequencer();
  const result: ToolResult = { toolCallId: "c1", ok: true, output: 42 };
  const step = makeToolResultStep(seq, result);

  assert.equal(step.stepType, "tool_result");
  assert.equal(step.status, "completed");
  assert.equal(step.sequenceNo, 1);
  assert.deepEqual(step.output, result);
});

test("makeToolResultStep marks failed results failed", () => {
  const seq = new StepSequencer();
  const result: ToolResult = { toolCallId: "c1", ok: false, error: "boom" };
  const step = makeToolResultStep(seq, result);

  assert.equal(step.status, "failed");
  assert.deepEqual(step.output, result);
});

test("pairCallsWithResults pairs by id and leaves unmatched calls undefined", () => {
  const calls: ToolCall[] = [
    { id: "a", name: "one", arguments: {} },
    { id: "b", name: "two", arguments: {} },
    { id: "c", name: "three", arguments: {} }
  ];
  const results: ToolResult[] = [
    { toolCallId: "c", ok: true, output: 3 },
    { toolCallId: "a", ok: false, error: "nope" }
  ];

  const paired = pairCallsWithResults(calls, results);

  assert.equal(paired.length, 3);
  assert.equal(paired[0].call.id, "a");
  assert.deepEqual(paired[0].result, { toolCallId: "a", ok: false, error: "nope" });
  assert.equal(paired[1].call.id, "b");
  assert.equal(paired[1].result, undefined);
  assert.equal(paired[2].call.id, "c");
  assert.deepEqual(paired[2].result, { toolCallId: "c", ok: true, output: 3 });
});
