import { logger } from "@packetchat/observability";
import { runFailureStatus, type RunClaim, type RunExecutionResult } from "@packetchat/agent-runtime";
import { dispatchAgentRun, type AgentRunDispatch } from "../agent-run-dispatch";

/**
 * Ports the approval route needs to finish a decided run. They are injected so
 * the resume flow can be tested without postgres, the provider adapters or the
 * queue.
 */
export type ResumeInProcessDeps = {
  runId: string;
  claim: () => Promise<RunClaim>;
  execute: (signal: AbortSignal) => Promise<RunExecutionResult>;
  record: (input: { status: string; text: string }) => Promise<void>;
  publicError: (error: unknown) => string;
  maxRunMs: number;
};

export type ResumeInProcessResult =
  | { executed: true; status: RunExecutionResult["status"] }
  | { executed: false };

/**
 * The in-process half of an approved resume. It claims the run first so a
 * timed-out enqueue that still landed cannot make the web and the worker both
 * execute the same resume: exactly one side wins the `queued -> running` claim.
 *
 * A failure to write the conversation message after the run itself succeeded is
 * rethrown rather than masked: the run row already says completed and "Error"
 * would contradict it.
 */
export async function resumeRunInProcess(deps: ResumeInProcessDeps): Promise<ResumeInProcessResult> {
  const claim = await deps.claim();
  if (!claim.claimed) {
    logger.info("Skipping in-process approval resume; the run is already claimed", {
      runId: deps.runId,
      status: claim.status
    });
    return { executed: false };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.maxRunMs);
  let executed = false;
  try {
    const result = await deps.execute(controller.signal);
    executed = true;
    await deps.record({ status: result.status, text: result.outputText });
    return { executed: true, status: result.status };
  } catch (error) {
    if (executed) throw error;
    // executeRun already classified this failure (cancelled/timed_out/failed)
    // on the run row; derive the same status here instead of relabelling every
    // failure "failed" and contradicting the row.
    const message = deps.publicError(error);
    await deps.record({ status: runFailureStatus(message), text: `Error: ${message}` }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Hands an approved resume to the queue and falls back to running it in this
 * process when the queue cannot take it. Same durability contract as the
 * initial run dispatch: a worker-owned run is resumed by the worker and the web
 * does not also execute it; only an unreachable queue degrades to in-process.
 */
export async function dispatchApprovedResume(
  deps: ResumeInProcessDeps & { enqueue: () => Promise<unknown> },
  context: { runId: string }
): Promise<AgentRunDispatch> {
  return dispatchAgentRun(
    {
      enqueue: deps.enqueue,
      executeDetached: () => {
        void resumeRunInProcess(deps).catch((error) => {
          logger.error("Approved resume could not run in process", {
            runId: context.runId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    },
    context
  );
}

export type FinalizeRejectedDeps = {
  addRunEvent: (runId: string, eventType: string, payload: Record<string, unknown>) => Promise<void>;
  addMessageStep: (input: {
    runId: string;
    name: string;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
  }) => Promise<void>;
  record: (input: { status: string; text: string }) => Promise<void>;
};

export function rejectedRunText(note: string): string {
  const trimmed = note.trim();
  return trimmed
    ? `Approval rejected. The run was cancelled before any external action ran. Note: ${trimmed}`
    : "Approval rejected. The run was cancelled before any external action ran.";
}

/**
 * Terminates a rejected run cleanly: the run row is already cancelled by the
 * decision transaction; this records the terminal step, event and the assistant
 * message so the conversation does not end on silence.
 */
export async function finalizeRejectedRun(
  deps: FinalizeRejectedDeps,
  input: { runId: string; approvalId: string; note: string }
): Promise<{ text: string }> {
  const text = rejectedRunText(input.note);
  await deps.addRunEvent(input.runId, "run.cancelled", { approvalId: input.approvalId, reason: "rejected" });
  await deps.addMessageStep({
    runId: input.runId,
    name: "Approval rejected",
    input: { approvalId: input.approvalId },
    output: { text }
  });
  await deps.record({ status: "cancelled", text });
  return { text };
}
