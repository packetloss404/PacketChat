import { getQueue, queueNames } from "./index";

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
  ownerUserId: string;
};

export type CleanupJob = {
  target: "job-failures" | "agent-runs" | "orphan-attachments" | "all";
  olderThanDays?: number;
};

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
  return getQueue(queueNames.providerSync).add(jobNames.providerSync, input, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 500
  });
}

export async function enqueueAgentRunJob(input: AgentRunJob): Promise<unknown> {
  return getQueue(queueNames.agentRun).add(jobNames.agentRun, input, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 500
  });
}

export async function enqueueCleanupJob(input: CleanupJob): Promise<unknown> {
  return getQueue(queueNames.cleanup).add(jobNames.cleanup, input, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 500
  });
}
