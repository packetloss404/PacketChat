import { RunBudget, BudgetExceededError } from "./budget";
import { StepSequencer, makeToolCallStep, makeToolResultStep, type ToolCall, type ToolResult, type RunStep } from "./tool-steps";

export type TurnResult = {
  text: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens?: number; outputTokens?: number };
};

export type RunAgentLoopOptions = {
  budget: RunBudget;
  sequencer: StepSequencer;
  runTurn: (ctx: { turn: number; priorResults: ToolResult[] }) => Promise<TurnResult>;
  executeTool: (call: ToolCall) => Promise<ToolResult>;
  maxTurns?: number;
};

export type LoopStopReason = "completed" | "budget" | "max_turns";

export type RunAgentLoopOutcome = {
  steps: RunStep[];
  finalText: string;
  stopReason: LoopStopReason;
};

const DEFAULT_MAX_TURNS = 8;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

export async function runAgentLoop(opts: RunAgentLoopOptions): Promise<RunAgentLoopOutcome> {
  const { budget, sequencer, runTurn, executeTool } = opts;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;

  const steps: RunStep[] = [];
  let finalText = "";
  let priorResults: ToolResult[] = [];

  for (let turn = 0; turn < maxTurns; turn += 1) {
    try {
      budget.startStep();
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        return { steps, finalText, stopReason: "budget" };
      }
      throw error;
    }

    const result = await runTurn({ turn, priorResults });
    finalText = result.text;

    steps.push({
      sequenceNo: sequencer.next(),
      stepType: "llm",
      status: "completed",
      output: { text: result.text, toolCalls: result.toolCalls, usage: result.usage }
    });

    const tokens = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
    if (tokens > 0) {
      budget.recordTokens(tokens);
    }

    if (result.toolCalls.length === 0) {
      return { steps, finalText, stopReason: "completed" };
    }

    const results: ToolResult[] = [];
    for (const call of result.toolCalls) {
      steps.push(makeToolCallStep(sequencer, call));

      let toolResult: ToolResult;
      try {
        toolResult = await executeTool(call);
      } catch (error) {
        toolResult = { toolCallId: call.id, ok: false, error: errorMessage(error) };
      }

      results.push(toolResult);
      steps.push(makeToolResultStep(sequencer, toolResult));
    }

    priorResults = results;

    try {
      budget.checkOrThrow();
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        return { steps, finalText, stopReason: "budget" };
      }
      throw error;
    }

    if (budget.isExhausted()) {
      return { steps, finalText, stopReason: "budget" };
    }
  }

  return { steps, finalText, stopReason: "max_turns" };
}
