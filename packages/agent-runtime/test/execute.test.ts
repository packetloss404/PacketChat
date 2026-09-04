import assert from "node:assert/strict";
import { test } from "node:test";
import type { NormalizedChatRequest, StreamEvent } from "@packetchat/contracts";
import type { ProviderAccountRuntime } from "@packetchat/providers";
import { executeRun } from "../src/execute";
import type { AgentRunDeps } from "../src/types";

type Recorded = {
  runStatus: string[];
  events: { type: string; payload: Record<string, unknown> }[];
  steps: { sequenceNo: number; stepType: string; status: string; name: string }[];
  stepOutcomes: { stepId: string | null; status: string }[];
  usage: number;
  failures: { status: string; errorCode: string; message: string }[];
  requests: NormalizedChatRequest[];
};

const account: ProviderAccountRuntime = {
  provider: "openai-compatible",
  displayName: "Test account",
  baseUrl: null,
  apiVersion: null,
  region: null,
  apiKey: "test-key"
};

function fakeDeps(overrides: Partial<AgentRunDeps> = {}) {
  const recorded: Recorded = { runStatus: [], events: [], steps: [], stepOutcomes: [], usage: 0, failures: [], requests: [] };
  let nextStepId = 0;

  const deps: AgentRunDeps = {
    markRunRunning: async () => { recorded.runStatus.push("running"); },
    markRunWaitingInput: async () => { recorded.runStatus.push("waiting_input"); },
    markRunCompleted: async () => { recorded.runStatus.push("completed"); },
    markRunFailed: async (input) => {
      recorded.runStatus.push(input.status);
      recorded.failures.push({ status: input.status, errorCode: input.errorCode, message: input.message });
    },
    addRunEvent: async (_runId, type, payload) => { recorded.events.push({ type, payload }); },
    addRunStep: async (input) => {
      recorded.steps.push({ sequenceNo: input.sequenceNo, stepType: input.stepType, status: input.status, name: input.name });
      nextStepId += 1;
      return `step-${nextStepId}`;
    },
    completeStep: async (stepId) => { recorded.stepOutcomes.push({ stepId, status: "completed" }); },
    failStep: async (stepId) => { recorded.stepOutcomes.push({ stepId, status: "failed" }); },
    searchKnowledgeContext: async () => [],
    fileContextBlock: async () => "",
    loadProviderAccount: async () => account,
    loadModelBinding: async () => ({ id: "binding-1", model: "gpt-4o-mini", display_name: "GPT-4o mini" }),
    loadChildAgent: async () => null,
    streamChat: async function* (_account, request) {
      recorded.requests.push(request);
      yield { type: "message_start", responseId: "resp-1" } as StreamEvent;
      yield { type: "text_delta", text: "Hello " } as StreamEvent;
      yield { type: "text_delta", text: "world" } as StreamEvent;
      yield { type: "message_end", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 2 } } as StreamEvent;
    },
    recordUsage: async () => { recorded.usage += 1; },
    resolveHost: async () => { throw new Error("resolveHost must not be reached in this test"); },
    fetch: async () => { throw new Error("fetch must not be reached in this test"); },
    ...overrides
  };

  return { deps, recorded };
}

const baseInput = {
  runId: "run-1",
  resourceOwnerUserId: "owner-1",
  inputText: "Say hello",
  spec: { providerAccountId: "account-1", model: "gpt-4o-mini" }
};

test("executeRun completes, records the llm step and returns the streamed text", async () => {
  const { deps, recorded } = fakeDeps();

  const result = await executeRun(deps, baseInput);

  assert.deepEqual(result, { status: "completed", outputText: "Hello world" });
  assert.deepEqual(recorded.runStatus, ["running", "completed"]);
  assert.deepEqual(recorded.steps, [{ sequenceNo: 1, stepType: "llm", status: "running", name: "Model response" }]);
  assert.deepEqual(recorded.stepOutcomes, [{ stepId: "step-1", status: "completed" }]);
  assert.equal(recorded.usage, 1);
  assert.deepEqual(recorded.events.map((event) => event.type), [
    "run.started",
    "model.messages.prepared",
    "provider.message_start",
    "provider.text_delta.summary",
    "provider.message_end",
    "run.completed"
  ]);
});

test("executeRun summarises text deltas once, with a count and a preview", async () => {
  const { deps, recorded } = fakeDeps();

  await executeRun(deps, baseInput);

  const summary = recorded.events.find((event) => event.type === "provider.text_delta.summary");
  assert.deepEqual(summary?.payload, { deltaCount: 2, chars: 11, preview: "Hello world" });
});

test("executeRun sends instructions and artifact guidance as system messages", async () => {
  const { deps, recorded } = fakeDeps();

  await executeRun(deps, {
    ...baseInput,
    spec: { ...baseInput.spec, instructions: "Be terse", artifacts: { enabled: true } }
  });

  const messages = recorded.requests[0]!.messages;
  assert.deepEqual(messages.map((message) => message.role), ["system", "system", "user"]);
  assert.equal(messages[0]!.content[0]!.text, "Be terse");
  assert.equal(messages[2]!.content[0]!.text, "Say hello");
});

test("executeRun stops at waiting_input when the spec needs external action approval", async () => {
  const { deps, recorded } = fakeDeps();

  const result = await executeRun(deps, {
    ...baseInput,
    spec: { ...baseInput.spec, openApiActions: [{ id: "a", name: "Lookup", method: "GET", url: "https://api.example/x" }] }
  });

  assert.deepEqual(result, {
    status: "waiting_input",
    approvalId: "step-1",
    outputText: "Waiting for approval before external actions run."
  });
  assert.deepEqual(recorded.runStatus, ["running", "waiting_input"]);
  assert.deepEqual(recorded.steps, [{ sequenceNo: 1, stepType: "approval", status: "running", name: "Approve external actions" }]);
  assert.deepEqual(recorded.events.map((event) => event.type), ["run.started", "approval.required"]);
  // Nothing external ran and the model was never called.
  assert.equal(recorded.usage, 0);
  assert.equal(recorded.requests.length, 0);
});

test("executeRun fails the run and hides an unrecognised provider error", async () => {
  const { deps, recorded } = fakeDeps({
    streamChat: async function* () {
      yield { type: "error", error: { code: "upstream", message: "ECONNREFUSED 10.0.0.4:443", retryable: true } } as StreamEvent;
    }
  });

  await assert.rejects(
    executeRun(deps, baseInput),
    /Agent run failed\. Check server logs or provider account settings for details\./
  );
  assert.deepEqual(recorded.runStatus, ["running", "failed"]);
  assert.deepEqual(recorded.failures, [{
    status: "failed",
    errorCode: "agent_run_failed",
    message: "Agent run failed. Check server logs or provider account settings for details."
  }]);
  assert.deepEqual(recorded.stepOutcomes, [{ stepId: "step-1", status: "failed" }]);
  assert.equal(recorded.events.at(-1)?.type, "run.failed");
});

test("executeRun surfaces a missing provider account verbatim", async () => {
  const { deps, recorded } = fakeDeps({ loadProviderAccount: async () => null });

  await assert.rejects(executeRun(deps, baseInput), /Provider account not found or is not available to this user\./);
  assert.deepEqual(recorded.failures.map((failure) => failure.errorCode), ["agent_run_failed"]);
});

test("executeRun surfaces a disabled model binding verbatim", async () => {
  const { deps } = fakeDeps({ loadModelBinding: async () => null });

  await assert.rejects(executeRun(deps, baseInput), /Agent model is disabled or no longer available for the selected provider account\./);
});

test("executeRun records a cancelled run when the signal is already aborted", async () => {
  const { deps, recorded } = fakeDeps();

  await assert.rejects(executeRun(deps, { ...baseInput, signal: AbortSignal.abort() }), /Agent run cancelled/);
  assert.deepEqual(recorded.failures, [{
    status: "cancelled",
    errorCode: "agent_run_cancelled",
    message: "Agent run cancelled"
  }]);
  // The failure lands before the llm step exists, so the step update matches nothing.
  assert.deepEqual(recorded.stepOutcomes, [{ stepId: null, status: "failed" }]);
});

test("executeRun folds knowledge search results into a context message", async () => {
  const { deps, recorded } = fakeDeps({
    searchKnowledgeContext: async () => [{
      knowledgeBaseId: "kb-1",
      knowledgeBaseName: "Runbooks",
      documentId: "doc-1",
      chunkId: "chunk-1",
      chunkIndex: 0,
      title: "Deploys",
      score: 3,
      snippet: "Restart the worker first.",
      citation: "Deploys#chunk-0"
    }]
  });

  await executeRun(deps, {
    ...baseInput,
    spec: { ...baseInput.spec, tools: { knowledgeSearch: true }, knowledgeBaseIds: ["kb-1"] }
  });

  assert.deepEqual(recorded.steps.map((step) => step.name), ["Knowledge search", "Model response"]);
  const messages = recorded.requests[0]!.messages;
  assert.equal(messages.length, 2);
  assert.match(messages[0]!.content[0]!.text, /1\. \[Deploys#chunk-0\] Restart the worker first\./);
});

test("executeRun runs the calculator tool and cites the result in context", async () => {
  const { deps, recorded } = fakeDeps();

  await executeRun(deps, {
    ...baseInput,
    inputText: "what is 2 + 2?",
    spec: { ...baseInput.spec, tools: { calculator: true } }
  });

  assert.deepEqual(recorded.steps.map((step) => step.name), ["Calculator", "Model response"]);
  assert.match(recorded.requests[0]!.messages[0]!.content[0]!.text, /Calculator result: 2 \+ 2 = 4/);
});
