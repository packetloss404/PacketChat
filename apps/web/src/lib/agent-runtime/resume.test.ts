import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyApprovalDecision,
  computeResumeState,
  type RunSnapshot,
  type StepSnapshot
} from "./resume";

test("computeResumeState halts when run status is terminal", () => {
  const run: RunSnapshot = { id: "run-1", status: "completed" };
  const steps: StepSnapshot[] = [
    { sequenceNo: 1, stepType: "approval", status: "running" }
  ];

  assert.deepEqual(computeResumeState(run, steps), {
    kind: "halt",
    reason: "terminal"
  });
});

test("computeResumeState blocks on a running approval step", () => {
  const run: RunSnapshot = { id: "run-2", status: "waiting_input" };
  const steps: StepSnapshot[] = [
    { sequenceNo: 1, stepType: "tool", status: "completed" },
    { sequenceNo: 2, stepType: "approval", status: "running" }
  ];

  assert.deepEqual(computeResumeState(run, steps), {
    kind: "blocked",
    pendingApprovalSeq: 2
  });
});

test("computeResumeState halts when the latest approval is rejected", () => {
  const run: RunSnapshot = { id: "run-3", status: "running" };
  const steps: StepSnapshot[] = [
    {
      sequenceNo: 1,
      stepType: "approval",
      status: "completed",
      output: { decision: "approved" }
    },
    {
      sequenceNo: 3,
      stepType: "approval",
      status: "cancelled",
      output: { decision: "rejected" }
    }
  ];

  assert.deepEqual(computeResumeState(run, steps), {
    kind: "halt",
    reason: "rejected"
  });
});

test("computeResumeState resumes after the latest approved approval", () => {
  const run: RunSnapshot = { id: "run-4", status: "running" };
  const steps: StepSnapshot[] = [
    {
      sequenceNo: 1,
      stepType: "approval",
      status: "completed",
      output: { decision: "rejected" }
    },
    {
      sequenceNo: 4,
      stepType: "approval",
      status: "completed",
      output: { decision: "approved" }
    }
  ];

  assert.deepEqual(computeResumeState(run, steps), {
    kind: "resume",
    fromSequenceNo: 4
  });
});

test("computeResumeState resumes from zero when there are no approval steps", () => {
  const run: RunSnapshot = { id: "run-5", status: "running" };
  const steps: StepSnapshot[] = [
    { sequenceNo: 1, stepType: "tool", status: "completed" }
  ];

  assert.deepEqual(computeResumeState(run, steps), {
    kind: "resume",
    fromSequenceNo: 0
  });
});

test("applyApprovalDecision sets approved approvals to completed without mutating input", () => {
  const steps: StepSnapshot[] = [
    { sequenceNo: 1, stepType: "tool", status: "completed" },
    { sequenceNo: 2, stepType: "approval", status: "running", output: null }
  ];
  const snapshot = JSON.parse(JSON.stringify(steps)) as StepSnapshot[];

  const result = applyApprovalDecision(steps, 2, "approved");

  assert.deepEqual(steps, snapshot);
  assert.notEqual(result, steps);
  assert.deepEqual(result[1], {
    sequenceNo: 2,
    stepType: "approval",
    status: "completed",
    output: { decision: "approved" }
  });
});

test("applyApprovalDecision sets rejected approvals to cancelled and preserves existing output", () => {
  const steps: StepSnapshot[] = [
    {
      sequenceNo: 7,
      stepType: "approval",
      status: "running",
      output: { decision: undefined }
    }
  ];

  const result = applyApprovalDecision(steps, 7, "rejected");

  assert.equal(result[0].status, "cancelled");
  assert.equal(result[0].output?.decision, "rejected");
  assert.equal(steps[0].status, "running");
});
