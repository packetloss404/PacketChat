import type { AgentSpec, RunExecutionResult } from "@packetchat/agent-runtime";
import type { AgentRunJob } from "@packetchat/jobs";
import { logger } from "@packetchat/observability";

/**
 * Everything the worker needs to reconstruct a run the web process created.
 *
 * The two user ids are deliberately distinct. `resourceOwnerUserId` is the
 * agent's owner and is what knowledge bases and child agents resolve against;
 * `callerUserId` is whoever started the run and owns the conversation the answer
 * is written into. For an agent shared through agent_permissions they are
 * different people.
 */
export type AgentRunContext = {
  runId: string;
  agentId: string;
  agentName: string;
  callerUserId: string;
  resourceOwnerUserId: string;
  conversationId: string | null;
  // The agent version's spec merged with the provider account and model that
  // were resolved when the run was created, so the worker executes exactly what
  // the caller would have got synchronously.
  spec: AgentSpec;
  inputText: string;
};

export type AgentRunClaim =
  | { claimed: true }
  | { claimed: false; status: string | null };

/**
 * Ports the handler needs from the outside world. The defaults (see
 * ./agent-run-deps) talk to postgres and the agent runtime; tests inject fakes.
 */
export type AgentRunJobDeps = {
  loadContext: (input: { runId: string; agentId: string }) => Promise<AgentRunContext | null>;
  claimRun: (runId: string) => Promise<AgentRunClaim>;
  execute: (input: { context: AgentRunContext; signal: AbortSignal }) => Promise<RunExecutionResult>;
  recordOutcome: (input: { context: AgentRunContext; status: string; text: string }) => Promise<void>;
  publicError: (error: unknown) => string;
};

export type AgentRunJobResult =
  | { executed: true; status: RunExecutionResult["status"] }
  // The run was already owned by someone else. `skippedStatus` is what the run
  // looked like at the time, for the log line.
  | { executed: false; skippedStatus: string | null };

function requiredId(value: unknown, field: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`agent-run job is missing ${field}`);
  return text;
}

/**
 * Executes one agent-run job.
 *
 * Failure is loud on purpose: anything that stops the run from executing throws,
 * so the job lands in job_failures and BullMQ retries it, rather than completing
 * as a success that ran nothing. The single exception is a run that is already
 * owned - a retry of an attempt that already reached a terminal state, or a
 * stalled job redelivered while another executor holds it. Re-running that would
 * duplicate paid provider calls and run events, and failing it would retry
 * forever over work that is already done, so it completes and says so.
 */
export async function runAgentRunJob(
  job: AgentRunJob,
  deps: AgentRunJobDeps,
  options: { maxRunMs: number }
): Promise<AgentRunJobResult> {
  const runId = requiredId(job?.runId, "runId");
  const agentId = requiredId(job?.agentId, "agentId");
  const resourceOwnerUserId = requiredId(job?.resourceOwnerUserId, "resourceOwnerUserId");

  const context = await deps.loadContext({ runId, agentId });
  if (!context) throw new Error(`agent-run job references an unknown run: ${runId}`);
  // The payload's owner is what the web route authorised against. If the
  // database disagrees, the job is stale or forged and executing it would
  // resolve knowledge and child agents against the wrong user's resources.
  if (context.resourceOwnerUserId !== resourceOwnerUserId) {
    throw new Error(`agent-run job owner does not match the agent owner for run ${runId}`);
  }

  const claim = await deps.claimRun(runId);
  if (!claim.claimed) return { executed: false, skippedStatus: claim.status };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.maxRunMs);
  let executed = false;
  try {
    const result = await deps.execute({ context, signal: controller.signal });
    executed = true;
    await deps.recordOutcome({ context, status: result.status, text: result.outputText });
    return { executed: true, status: result.status };
  } catch (error) {
    // The run itself succeeded and only the conversation write failed. Writing
    // "Error: ..." here would contradict a run row that says completed and throw
    // away the real answer, which the claim guard means no retry can recover.
    if (executed) {
      logger.error("Agent run completed but its conversation message could not be written", {
        runId: context.runId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }

    // The executor has already marked the run row failed. The conversation still
    // needs the error message the synchronous path would have written, and a
    // failure to write it must not mask the original error.
    const message = deps.publicError(error);
    await deps.recordOutcome({ context, status: "failed", text: `Error: ${message}` }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
