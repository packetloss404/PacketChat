export const WORKER_QUEUE_NAMES = ["provider-sync", "file-ingestion", "agent-run", "cleanup"] as const;

export type WorkerQueueName = typeof WORKER_QUEUE_NAMES[number];

export class UnknownJobError extends Error {
  readonly queueName: string;
  readonly jobName?: string;

  constructor(queueName: string, jobName?: string) {
    const detail = jobName === undefined ? `queue "${queueName}"` : `job "${jobName}" on queue "${queueName}"`;
    super(`Unknown ${detail}`);
    this.name = "UnknownJobError";
    this.queueName = queueName;
    this.jobName = jobName;
  }
}

export function isWorkerQueue(name: string): name is WorkerQueueName {
  return (WORKER_QUEUE_NAMES as readonly string[]).includes(name);
}

export function assertWorkerQueue(name: string): WorkerQueueName {
  if (!isWorkerQueue(name)) {
    throw new UnknownJobError(name);
  }
  return name;
}

export function routeJob<H>(queueName: string, handlers: Record<WorkerQueueName, H>): H {
  const narrowed = assertWorkerQueue(queueName);
  return handlers[narrowed];
}

export function assertKnownJobName(queueName: WorkerQueueName, jobName: string, allowed: readonly string[]): void {
  if (!allowed.includes(jobName)) {
    throw new UnknownJobError(queueName, jobName);
  }
}
