export type ToolCall = { id: string; name: string; arguments: unknown };

export type ToolResult = { toolCallId: string; ok: boolean; output?: unknown; error?: string };

export type RunStepType = "llm" | "tool_call" | "tool_result" | "approval" | "message";

export type RunStepStatus = "running" | "completed" | "failed" | "cancelled";

export type RunStep = {
  sequenceNo: number;
  stepType: RunStepType;
  status: RunStepStatus;
  name?: string;
  input?: unknown;
  output?: unknown;
};

export class StepSequencer {
  private value: number;

  constructor(start?: number) {
    this.value = start ?? 1;
  }

  next(): number {
    const seq = this.value;
    this.value += 1;
    return seq;
  }

  current(): number {
    return this.value;
  }
}

export function makeToolCallStep(seq: StepSequencer, call: ToolCall): RunStep {
  return {
    sequenceNo: seq.next(),
    stepType: "tool_call",
    status: "running",
    name: call.name,
    input: call
  };
}

export function makeToolResultStep(seq: StepSequencer, result: ToolResult): RunStep {
  return {
    sequenceNo: seq.next(),
    stepType: "tool_result",
    status: result.ok ? "completed" : "failed",
    output: result
  };
}

export function pairCallsWithResults(
  calls: ToolCall[],
  results: ToolResult[]
): Array<{ call: ToolCall; result: ToolResult | undefined }> {
  const resultsById = new Map<string, ToolResult>();
  for (const result of results) {
    resultsById.set(result.toolCallId, result);
  }

  return calls.map((call) => ({
    call,
    result: resultsById.get(call.id)
  }));
}
