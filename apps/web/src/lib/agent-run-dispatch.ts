import { logger } from "@packetchat/observability";

export type AgentRunDispatchDeps = {
  enqueue: () => Promise<unknown>;
  // Starts the run in this process and returns immediately. It must not throw:
  // there is nowhere left to fall back to.
  executeDetached: () => void;
};

export type AgentRunDispatch =
  | { mode: "queued" }
  | { mode: "in_process"; reason: string };

/**
 * Hands an async run to the queue, and falls back to running it in this process
 * when the queue cannot take it.
 *
 * Degrading beats refusing: an unreachable Redis should cost the run its
 * durability, not the caller their answer. The enqueue is already bounded by
 * withEnqueueTimeout, so this catch is reachable rather than hanging behind
 * ioredis's offline queue.
 *
 * The fallback is not a second executor: a timed-out enqueue can still land the
 * job, so the in-process path claims the run first and does nothing if the
 * worker got there.
 */
export async function dispatchAgentRun(deps: AgentRunDispatchDeps, context: { runId: string }): Promise<AgentRunDispatch> {
  try {
    await deps.enqueue();
    return { mode: "queued" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn("Agent run enqueue failed; running in process instead", { runId: context.runId, error: reason });
    deps.executeDetached();
    return { mode: "in_process", reason };
  }
}
