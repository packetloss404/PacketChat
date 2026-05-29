import assert from "node:assert/strict";
import { test } from "node:test";
import { RunBudget, type RunBudgetLimits } from "./budget";
import { StepSequencer, type ToolCall, type ToolResult, type RunStep } from "./tool-steps";
import { runAgentLoop, type TurnResult } from "./loop";

function generousBudget(overrides?: Partial<RunBudgetLimits>): RunBudget {
  return new RunBudget(
    {
      maxSteps: 100,
      maxTotalTokens: 1_000_000,
      maxWallClockMs: 1_000_000,
      maxPayloadBytes: 1_000_000,
      ...overrides
    },
    { now: () => 0 }
  );
}

function call(id: string, name: string): ToolCall {
  return { id, name, arguments: {} };
}

function stepTypes(steps: RunStep[]): string[] {
  return steps.map((s) => s.stepType);
}

test("completes after two tool turns then a final text", async () => {
  const turns: TurnResult[] = [
    { text: "thinking 1", toolCalls: [call("c1", "search")], usage: { inputTokens: 10, outputTokens: 5 } },
    { text: "thinking 2", toolCalls: [call("c2", "fetch")], usage: { inputTokens: 8, outputTokens: 4 } },
    { text: "all done", toolCalls: [] }
  ];

  let turnIdx = 0;
  const seenPrior: ToolResult[][] = [];

  const outcome = await runAgentLoop({
    budget: generousBudget(),
    sequencer: new StepSequencer(),
    runTurn: async ({ priorResults }) => {
      seenPrior.push(priorResults);
      const t = turns[turnIdx];
      turnIdx += 1;
      return t;
    },
    executeTool: async (c) => ({ toolCallId: c.id, ok: true, output: `out-${c.id}` })
  });

  assert.equal(outcome.stopReason, "completed");
  assert.equal(outcome.finalText, "all done");

  assert.deepEqual(stepTypes(outcome.steps), [
    "llm",
    "tool_call",
    "tool_result",
    "llm",
    "tool_call",
    "tool_result",
    "llm"
  ]);
  // Sequence numbers are monotonic starting at 1.
  assert.deepEqual(outcome.steps.map((s) => s.sequenceNo), [1, 2, 3, 4, 5, 6, 7]);

  // Prior tool results are fed forward to the next turn.
  assert.deepEqual(seenPrior[0], []);
  assert.equal(seenPrior[1][0].toolCallId, "c1");
  assert.equal(seenPrior[2][0].toolCallId, "c2");
});

test("stops with budget reason when the step budget is exhausted", async () => {
  let turnCalls = 0;

  const outcome = await runAgentLoop({
    // maxSteps 2: turn 0 consumes step 1 and runs; turn 1 consumes step 2 and trips the budget before runTurn.
    budget: generousBudget({ maxSteps: 2 }),
    sequencer: new StepSequencer(),
    runTurn: async () => {
      turnCalls += 1;
      return { text: "go", toolCalls: [call("c1", "search")] };
    },
    executeTool: async (c) => ({ toolCallId: c.id, ok: true, output: "x" })
  });

  assert.equal(outcome.stopReason, "budget");
  assert.equal(turnCalls, 1);
});

test("records a failed tool_result when executeTool throws and continues gracefully", async () => {
  const turns: TurnResult[] = [
    { text: "use tool", toolCalls: [call("c1", "boom")] },
    { text: "recovered", toolCalls: [] }
  ];
  let turnIdx = 0;

  const outcome = await runAgentLoop({
    budget: generousBudget(),
    sequencer: new StepSequencer(),
    runTurn: async () => {
      const t = turns[turnIdx];
      turnIdx += 1;
      return t;
    },
    executeTool: async () => {
      throw new Error("tool blew up");
    }
  });

  assert.equal(outcome.stopReason, "completed");
  assert.equal(outcome.finalText, "recovered");

  const toolResultStep = outcome.steps.find((s) => s.stepType === "tool_result");
  assert.ok(toolResultStep, "expected a tool_result step");
  const result = toolResultStep.output as ToolResult;
  assert.equal(result.ok, false);
  assert.equal(result.error, "tool blew up");
});

test("stops with max_turns when runTurn keeps returning tool calls", async () => {
  let turnCalls = 0;

  const outcome = await runAgentLoop({
    budget: generousBudget(),
    sequencer: new StepSequencer(),
    maxTurns: 3,
    runTurn: async () => {
      turnCalls += 1;
      return { text: `turn ${turnCalls}`, toolCalls: [call(`c${turnCalls}`, "loop")] };
    },
    executeTool: async (c) => ({ toolCallId: c.id, ok: true, output: "x" })
  });

  assert.equal(outcome.stopReason, "max_turns");
  assert.equal(turnCalls, 3);
  assert.equal(outcome.finalText, "turn 3");
});
