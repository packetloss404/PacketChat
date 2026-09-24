import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyApprovalDecision,
  computeResumeState,
  nextSequenceNo,
  planResume,
  type RunSnapshot,
  type StepSnapshot
} from "../src/resume";

const run = (status: RunSnapshot["status"]): RunSnapshot => ({ id: "run-1", status });

function approval(sequenceNo: number, status: StepSnapshot["status"], decision?: "approved" | "rejected"): StepSnapshot {
  const step: StepSnapshot = { sequenceNo, stepType: "approval", status };
  if (decision) step.output = { decision };
  return step;
}

test("computeResumeState halts a terminal run", () => {
  assert.deepEqual(computeResumeState(run("completed"), [approval(1, "running")]), {
    kind: "halt",
    reason: "terminal"
  });
});

test("computeResumeState blocks while an approval is still running", () => {
  assert.deepEqual(computeResumeState(run("waiting_input"), [approval(2, "running")]), {
    kind: "blocked",
    pendingApprovalSeq: 2
  });
});

test("computeResumeState halts a rejected run", () => {
  assert.deepEqual(computeResumeState(run("running"), [approval(3, "cancelled", "rejected")]), {
    kind: "halt",
    reason: "rejected"
  });
});

test("computeResumeState resumes after the latest approved approval", () => {
  assert.deepEqual(computeResumeState(run("running"), [approval(1, "cancelled", "rejected"), approval(4, "completed", "approved")]), {
    kind: "resume",
    fromSequenceNo: 4
  });
});

test("computeResumeState resumes from zero when there is no approval yet", () => {
  assert.deepEqual(computeResumeState(run("queued"), []), { kind: "resume", fromSequenceNo: 0 });
});

test("applyApprovalDecision does not mutate its input", () => {
  const steps = [approval(1, "running")];
  const snapshot = JSON.parse(JSON.stringify(steps)) as StepSnapshot[];

  const result = applyApprovalDecision(steps, 1, "approved");

  assert.deepEqual(steps, snapshot);
  assert.equal(result[0]?.status, "completed");
  assert.equal(result[0]?.output?.decision, "approved");
});

test("nextSequenceNo continues after the highest existing step", () => {
  assert.equal(nextSequenceNo([]), 1);
  assert.equal(nextSequenceNo([{ sequenceNo: 1 }, { sequenceNo: 7 }, { sequenceNo: 3 }]), 8);
});

test("planResume marks a fresh run with approvalSequenceNo zero", () => {
  assert.deepEqual(planResume(run("queued"), []), {
    kind: "resume",
    approvalSequenceNo: 0,
    nextSequenceNo: 1
  });
});

test("planResume continues numbering when resuming an approved run", () => {
  assert.deepEqual(planResume(run("queued"), [approval(1, "completed", "approved")]), {
    kind: "resume",
    approvalSequenceNo: 1,
    nextSequenceNo: 2
  });
});

test("planResume reports rejection and terminal as halts", () => {
  assert.deepEqual(planResume(run("cancelled"), [approval(1, "cancelled", "rejected")]), {
    kind: "halt",
    reason: "terminal"
  });
  assert.deepEqual(planResume(run("running"), [approval(1, "cancelled", "rejected")]), {
    kind: "halt",
    reason: "rejected"
  });
});
