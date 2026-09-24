import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunClaim, RunExecutionResult } from "@packetchat/agent-runtime";
import { dispatchApprovedResume, finalizeRejectedRun, resumeRunInProcess } from "../src/lib/agent-runtime/approval-resume";

test("an approved resume that enqueues is handed to the worker and not executed in process", async () => {
  let enqueued = 0;
  let claimed = 0;
  let executed = 0;

  const result = await dispatchApprovedResume(
    {
      runId: "run-1",
      enqueue: async () => {
        enqueued += 1;
      },
      claim: async (): Promise<RunClaim> => {
        claimed += 1;
        return { claimed: true };
      },
      execute: async (): Promise<RunExecutionResult> => {
        executed += 1;
        return { status: "completed", outputText: "never" };
      },
      record: async () => {},
      publicError: (error) => String(error),
      maxRunMs: 1_000
    },
    { runId: "run-1" }
  );

  assert.deepEqual(result, { mode: "queued" });
  assert.equal(enqueued, 1);
  assert.equal(claimed, 0, "the worker owns the resume once it is enqueued");
  assert.equal(executed, 0, "a queued resume must not also execute in this process");
});

test("an enqueue failure resumes in process after claiming, reaching a final answer", async () => {
  let executed = 0;
  const recorded: { status: string; text: string }[] = [];

  const result = await dispatchApprovedResume(
    {
      runId: "run-1",
      enqueue: async () => {
        throw new Error("agent-run enqueue timed out after 5000ms");
      },
      claim: async (): Promise<RunClaim> => ({ claimed: true }),
      execute: async (): Promise<RunExecutionResult> => {
        executed += 1;
        return { status: "completed", outputText: "the final answer" };
      },
      record: async (input) => {
        recorded.push(input);
      },
      publicError: (error) => String(error),
      maxRunMs: 1_000
    },
    { runId: "run-1" }
  );

  assert.deepEqual(result, { mode: "in_process", reason: "agent-run enqueue timed out after 5000ms" });
  // The in-process half is deliberately detached; let its microtasks settle.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(executed, 1);
  assert.deepEqual(recorded, [{ status: "completed", text: "the final answer" }]);
});

test("a resume another executor already claimed is not executed in process", async () => {
  let executed = 0;

  const result = await resumeRunInProcess({
    runId: "run-1",
    claim: async (): Promise<RunClaim> => ({ claimed: false, status: "running" }),
    execute: async (): Promise<RunExecutionResult> => {
      executed += 1;
      return { status: "completed", outputText: "duplicate" };
    },
    record: async () => {},
    publicError: (error) => String(error),
    maxRunMs: 1_000
  });

  assert.deepEqual(result, { executed: false });
  assert.equal(executed, 0, "losing the claim means someone else is resuming the run");
});

test("resumeRunInProcess records the completed status and final answer", async () => {
  const recorded: { status: string; text: string }[] = [];

  const result = await resumeRunInProcess({
    runId: "run-1",
    claim: async (): Promise<RunClaim> => ({ claimed: true }),
    execute: async (): Promise<RunExecutionResult> => ({ status: "completed", outputText: "final answer" }),
    record: async (input) => {
      recorded.push(input);
    },
    publicError: (error) => String(error),
    maxRunMs: 1_000
  });

  assert.deepEqual(result, { executed: true, status: "completed" });
  assert.deepEqual(recorded, [{ status: "completed", text: "final answer" }]);
});

test("resumeRunInProcess records a failed run's error without masking the throw", async () => {
  const recorded: { status: string; text: string }[] = [];

  await assert.rejects(
    resumeRunInProcess({
      runId: "run-1",
      claim: async (): Promise<RunClaim> => ({ claimed: true }),
      execute: async (): Promise<RunExecutionResult> => {
        throw new Error("provider account not found");
      },
      record: async (input) => {
        recorded.push(input);
      },
      publicError: (error) => (error instanceof Error ? error.message : String(error)),
      maxRunMs: 1_000
    }),
    /provider account not found/
  );

  assert.deepEqual(recorded, [{ status: "failed", text: "Error: provider account not found" }]);
});

test("resumeRunInProcess records a cancellation with the run's own status, not failed", async () => {
  const recorded: { status: string; text: string }[] = [];

  await assert.rejects(
    resumeRunInProcess({
      runId: "run-1",
      claim: async (): Promise<RunClaim> => ({ claimed: true }),
      execute: async (): Promise<RunExecutionResult> => {
        throw new Error("Agent run cancelled");
      },
      record: async (input) => {
        recorded.push(input);
      },
      publicError: (error) => (error instanceof Error ? error.message : String(error)),
      maxRunMs: 1_000
    }),
    /Agent run cancelled/
  );

  assert.deepEqual(recorded, [{ status: "cancelled", text: "Error: Agent run cancelled" }]);
});

test("finalizeRejectedRun cancels the run with a clear terminal message", async () => {
  const events: { runId: string; type: string; payload: Record<string, unknown> }[] = [];
  const steps: { name: string; output: Record<string, unknown> }[] = [];
  const recorded: { status: string; text: string }[] = [];

  const result = await finalizeRejectedRun(
    {
      addRunEvent: async (runId, eventType, payload) => {
        events.push({ runId, type: eventType, payload });
      },
      addMessageStep: async (input) => {
        steps.push({ name: input.name, output: input.output });
      },
      record: async (input) => {
        recorded.push(input);
      }
    },
    { runId: "run-1", approvalId: "approval-1", note: "not while on call" }
  );

  assert.equal(events[0]?.type, "run.cancelled");
  assert.deepEqual(events[0]?.payload, { approvalId: "approval-1", reason: "rejected" });
  assert.equal(steps[0]?.name, "Approval rejected");
  assert.match(result.text, /rejected/i);
  assert.match(result.text, /not while on call/);
  assert.deepEqual(recorded, [{ status: "cancelled", text: result.text }]);
});
