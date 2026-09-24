import { getQueue, queueNames, withEnqueueTimeout } from "./index";

export const jobNames = {
  providerSync: "sync-provider",
  agentRun: "run-agent",
  cleanup: "run-cleanup"
} as const;

export type ProviderSyncJob = {
  providerAccountId: string;
};

export type AgentRunJob = {
  runId: string;
  agentId: string;
  // The AGENT's owner, not the caller who started the run. The executor resolves
  // knowledge bases and child agents against this id, and an agent shared
  // through agent_permissions is run by someone who owns none of them; passing
  // the caller here would resolve against the wrong user's resources. The
  // caller is already on the run row as agent_runs.owner_user_id, which is what
  // the run's conversation message is attributed to.
  resourceOwnerUserId: string;
  // The user turn the run's final answer must be parented under. Also persisted
  // on agent_runs.user_message_id; carried here so the worker can record the
  // answer against the right node even if the row read is degraded. Null for a
  // run with no conversation.
  userMessageId?: string | null;
};

// The concrete retention targets the worker knows how to clean. Spelled exactly
// as CleanupTarget in apps/worker/src/cleanup.ts ("completed-runs", not
// "agent-runs") so a queue payload maps onto a worker target with no
// translation table; the worker asserts at compile time that the two unions
// still agree.
export const CLEANUP_TARGETS = ["job-failures", "completed-runs", "orphan-attachments"] as const;

export type CleanupJobTarget = typeof CLEANUP_TARGETS[number];

export type CleanupJob = {
  target: CleanupJobTarget | "all";
  olderThanDays?: number;
};

// Daily at 03:15 in the worker process timezone: past the midnight rollover and
// off the top of the hour, so retention deletes do not land on whatever else
// the host runs on a round schedule.
export const CLEANUP_SCHEDULE_ID = "daily-cleanup";
export const CLEANUP_SCHEDULE_PATTERN = "15 3 * * *";

// Literal list (mirrors the values of queueNames in ./index). Kept as a literal
// rather than Object.values(queueNames) so this module has no top-level
// dependency on ./index's runtime bindings — ./index re-exports this module, and
// reading queueNames at load time would hit a circular-import TDZ.
export const KNOWN_QUEUE_NAMES: readonly string[] = [
  "provider-sync",
  "file-ingestion",
  "agent-run",
  "cleanup"
];

export function isKnownQueue(name: string): boolean {
  return KNOWN_QUEUE_NAMES.includes(name);
}

export function assertKnownQueue(name: string): void {
  if (!isKnownQueue(name)) {
    throw new Error(`Unknown queue: ${name}`);
  }
}

export async function enqueueProviderSyncJob(input: ProviderSyncJob): Promise<unknown> {
  // Deterministic jobId: while a sync for this account is still queued, a second
  // request collapses onto it instead of racing it. This is a de-duplication
  // convenience, not the correctness boundary - the worker takes an advisory
  // lock per account, which is what actually prevents concurrent writers.
  return withEnqueueTimeout("provider-sync enqueue", () => getQueue(queueNames.providerSync).add(jobNames.providerSync, input, {
    jobId: `sync-${input.providerAccountId}`,
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 500
  }));
}

export async function enqueueAgentRunJob(input: AgentRunJob): Promise<unknown> {
  return withEnqueueTimeout("agent-run enqueue", () => getQueue(queueNames.agentRun).add(jobNames.agentRun, input, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 500
  }));
}

export async function enqueueCleanupJob(input: CleanupJob): Promise<unknown> {
  return withEnqueueTimeout("cleanup enqueue", () => getQueue(queueNames.cleanup).add(jobNames.cleanup, input, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 500
  }));
}

export async function registerCleanupSchedule(input: { pattern?: string } = {}): Promise<unknown> {
  const data: CleanupJob = { target: "all" };
  // upsertJobScheduler is keyed by CLEANUP_SCHEDULE_ID, so calling this on every
  // worker boot replaces the one scheduler instead of stacking a new repeatable
  // per restart. A changed pattern is applied on the next boot for the same
  // reason.
  return getQueue(queueNames.cleanup).upsertJobScheduler(
    CLEANUP_SCHEDULE_ID,
    { pattern: input.pattern ?? CLEANUP_SCHEDULE_PATTERN },
    {
      name: jobNames.cleanup,
      data,
      opts: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: 100,
        removeOnFail: 500
      }
    }
  );
}
