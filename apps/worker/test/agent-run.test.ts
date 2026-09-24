import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunJob } from "@packetchat/jobs";
import { runAgentRunJob, type AgentRunClaim, type AgentRunContext, type AgentRunJobDeps } from "../src/agent-run";

const OWNER = "00000000-0000-0000-0000-0000000000aa";
const CALLER = "00000000-0000-0000-0000-0000000000bb";

const job: AgentRunJob = {
  runId: "run-1",
  agentId: "agent-1",
  resourceOwnerUserId: OWNER
};

function context(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    runId: "run-1",
    agentId: "agent-1",
    agentName: "Test agent",
    callerUserId: CALLER,
    resourceOwnerUserId: OWNER,
    conversationId: "conversation-1",
    spec: { providerAccountId: "account-1", model: "model-1" },
    inputText: "hello",
    userMessageId: "user-message-1",
    ...overrides
  };
}

type Recorded = { status: string; text: string; userId: string; ownerUserId: string; userMessageId: string | null };

function makeDeps(overrides: Partial<AgentRunJobDeps> = {}) {
  const executed: AgentRunContext[] = [];
  const recorded: Recorded[] = [];
  const claims: string[] = [];

  const deps: AgentRunJobDeps = {
    loadContext: async () => context(),
    claimRun: async (runId) => {
      claims.push(runId);
      return { claimed: true } satisfies AgentRunClaim;
    },
    execute: async ({ context: runContext }) => {
      executed.push(runContext);
      return { status: "completed", outputText: "done" };
    },
    recordOutcome: async ({ context: runContext, status, text }) => {
      recorded.push({
        status,
        text,
        userId: runContext.callerUserId,
        ownerUserId: runContext.resourceOwnerUserId,
        userMessageId: runContext.userMessageId
      });
    },
    publicError: (error) => (error instanceof Error ? error.message : String(error)),
    ...overrides
  };

  return { deps, executed, recorded, claims };
}

test("a claimed run executes and records the outcome against the caller", async () => {
  const { deps, executed, recorded } = makeDeps();

  const result = await runAgentRunJob(job, deps, { maxRunMs: 60_000 });

  assert.deepEqual(result, { executed: true, status: "completed" });
  assert.equal(executed.length, 1);
  assert.equal(executed[0]?.resourceOwnerUserId, OWNER, "the executor resolves resources as the agent owner");
  assert.deepEqual(recorded, [{ status: "completed", text: "done", userId: CALLER, ownerUserId: OWNER, userMessageId: "user-message-1" }]);
});

test("a waiting_input run is a normal outcome, not a failure", async () => {
  const { deps, recorded } = makeDeps({
    execute: async () => ({ status: "waiting_input", approvalId: "approval-1", outputText: "waiting" })
  });

  const result = await runAgentRunJob(job, deps, { maxRunMs: 60_000 });

  assert.deepEqual(result, { executed: true, status: "waiting_input" });
  assert.equal(recorded[0]?.status, "waiting_input");
});

test("a retry of a run that already reached a terminal state does not execute it again", async () => {
  const { deps, executed, recorded } = makeDeps({
    claimRun: async () => ({ claimed: false, status: "completed" })
  });

  const result = await runAgentRunJob(job, deps, { maxRunMs: 60_000 });

  assert.deepEqual(result, { executed: false, skippedStatus: "completed" });
  assert.equal(executed.length, 0, "a terminal run must not be re-executed");
  assert.equal(recorded.length, 0, "a skipped run must not write a second conversation message");
});

test("a run another executor is already running is skipped rather than duplicated", async () => {
  const { deps, executed } = makeDeps({
    claimRun: async () => ({ claimed: false, status: "running" })
  });

  const result = await runAgentRunJob(job, deps, { maxRunMs: 60_000 });

  assert.deepEqual(result, { executed: false, skippedStatus: "running" });
  assert.equal(executed.length, 0);
});

test("the run is claimed before anything is executed", async () => {
  const order: string[] = [];
  const { deps } = makeDeps({
    claimRun: async () => {
      order.push("claim");
      return { claimed: true };
    },
    execute: async () => {
      order.push("execute");
      return { status: "completed", outputText: "done" };
    }
  });

  await runAgentRunJob(job, deps, { maxRunMs: 60_000 });

  assert.deepEqual(order, ["claim", "execute"]);
});

test("an execution failure rethrows so the job fails loudly, and still records the error", async () => {
  const { deps, recorded } = makeDeps({
    execute: async () => {
      throw new Error("provider account not found");
    }
  });

  await assert.rejects(
    runAgentRunJob(job, deps, { maxRunMs: 60_000 }),
    /provider account not found/,
    "a failed run must surface as a failed job"
  );
  assert.deepEqual(recorded, [{ status: "failed", text: "Error: provider account not found", userId: CALLER, ownerUserId: OWNER, userMessageId: "user-message-1" }]);
});

test("a failure to record the outcome does not mask the original failure", async () => {
  const { deps } = makeDeps({
    execute: async () => {
      throw new Error("upstream exploded");
    },
    recordOutcome: async () => {
      throw new Error("conversation write failed");
    }
  });

  await assert.rejects(runAgentRunJob(job, deps, { maxRunMs: 60_000 }), /upstream exploded/);
});

test("the execution cap aborts the run and fails the job", async () => {
  const { deps, recorded } = makeDeps({
    execute: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Agent run cancelled")));
    })
  });

  await assert.rejects(runAgentRunJob(job, deps, { maxRunMs: 1 }), /Agent run cancelled/);
  assert.equal(recorded[0]?.text, "Error: Agent run cancelled");
  // executeRun would have written "cancelled" on the run row; the conversation
  // message must agree instead of a blanket "failed".
  assert.equal(recorded[0]?.status, "cancelled");
});

test("the payload's user message id is handed to the context loader", async () => {
  const loadInputs: Array<{ runId: string; agentId: string; userMessageId?: string | null }> = [];
  const { deps, recorded } = makeDeps({
    loadContext: async (input) => {
      loadInputs.push(input);
      return context();
    }
  });

  await runAgentRunJob({ ...job, userMessageId: "payload-message-9" }, deps, { maxRunMs: 60_000 });

  assert.deepEqual(loadInputs, [{ runId: "run-1", agentId: "agent-1", userMessageId: "payload-message-9" }]);
  assert.equal(recorded[0]?.userMessageId, "user-message-1", "the row's id wins when the loader returns one");
});

test("a job for a run that no longer exists fails loudly", async () => {
  const { deps, claims } = makeDeps({ loadContext: async () => null });

  await assert.rejects(runAgentRunJob(job, deps, { maxRunMs: 60_000 }), /unknown run/);
  assert.equal(claims.length, 0, "a missing run must not be claimed");
});

test("a job whose owner disagrees with the agent owner is refused before executing", async () => {
  const { deps, executed, claims } = makeDeps();

  await assert.rejects(
    runAgentRunJob({ ...job, resourceOwnerUserId: CALLER }, deps, { maxRunMs: 60_000 }),
    /owner does not match/,
    "resolving another user's knowledge and child agents must not be possible"
  );
  assert.equal(claims.length, 0);
  assert.equal(executed.length, 0);
});

test("an incomplete payload fails loudly rather than executing something arbitrary", async () => {
  const { deps } = makeDeps();

  await assert.rejects(runAgentRunJob({ ...job, runId: "  " }, deps, { maxRunMs: 60_000 }), /missing runId/);
  await assert.rejects(runAgentRunJob({ ...job, agentId: "" }, deps, { maxRunMs: 60_000 }), /missing agentId/);
  await assert.rejects(
    runAgentRunJob({ ...job, resourceOwnerUserId: undefined } as unknown as AgentRunJob, deps, { maxRunMs: 60_000 }),
    /missing resourceOwnerUserId/
  );
  await assert.rejects(
    runAgentRunJob(undefined as unknown as AgentRunJob, deps, { maxRunMs: 60_000 }),
    /missing runId/
  );
});
