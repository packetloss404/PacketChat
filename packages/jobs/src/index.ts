import { Queue, Worker, type Processor } from "bullmq";
import { createHash, randomUUID } from "node:crypto";
import IORedis from "ioredis";
import { getConfig } from "@packetchat/config";

export const queueNames = {
  providerSync: "provider-sync",
  fileIngestion: "file-ingestion",
  agentRun: "agent-run",
  cleanup: "cleanup"
} as const;

export type FileIngestionJob = {
  documentId: string;
  knowledgeBaseId: string;
  ownerUserId: string;
  attachmentId: string;
};

export type RateLimitAlgorithm = "fixed-window" | "sliding-window";

export type RateLimitInput = {
  namespace: string;
  identifier: string;
  limit: number;
  windowSeconds: number;
  algorithm?: RateLimitAlgorithm;
};

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfterSeconds: number;
};

let connection: IORedis | undefined;
const queues = new Map<string, Queue>();

function rateLimitKey(namespace: string, identifier: string, windowId?: number) {
  const safeNamespace = namespace.replace(/[^a-zA-Z0-9:_-]/g, "_");
  const identityHash = createHash("sha256").update(identifier).digest("hex");
  return ["packetchat", "rate-limit", safeNamespace, identityHash, windowId].filter((part) => part !== undefined).join(":");
}

export function getRedisConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(getConfig().REDIS_URL, { maxRetriesPerRequest: null });
  }

  return connection;
}

export function createQueue(name: string): Queue {
  return new Queue(name, { connection: getRedisConnection() });
}

export function getQueue(name: string): Queue {
  const existing = queues.get(name);
  if (existing) return existing;

  const queue = createQueue(name);
  queues.set(name, queue);
  return queue;
}

export async function enqueueFileIngestionJob(input: FileIngestionJob) {
  return getQueue(queueNames.fileIngestion).add("ingest-file", input, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 500
  });
}

export function createWorker<T>(name: string, handler: Processor<T>): Worker<T> {
  return new Worker<T>(name, handler, {
    connection: getRedisConnection(),
    concurrency: getConfig().WORKER_CONCURRENCY
  });
}

export async function checkRedis(): Promise<void> {
  await getRedisConnection().ping();
}

export async function checkRateLimit(input: RateLimitInput): Promise<RateLimitResult> {
  const limit = Math.max(1, Math.floor(input.limit));
  const windowSeconds = Math.max(1, Math.floor(input.windowSeconds));
  const nowMs = Date.now();
  const algorithm = input.algorithm ?? "sliding-window";

  if (algorithm === "fixed-window") {
    const windowId = Math.floor(nowMs / (windowSeconds * 1_000));
    const key = rateLimitKey(input.namespace, input.identifier, windowId);
    const count = Number(await getRedisConnection().eval(
      `
        local count = redis.call("INCR", KEYS[1])
        if count == 1 then redis.call("EXPIRE", KEYS[1], tonumber(ARGV[1])) end
        return count
      `,
      1,
      key,
      windowSeconds + 1
    ));

    const resetAtMs = (windowId + 1) * windowSeconds * 1_000;
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt: new Date(resetAtMs),
      retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - nowMs) / 1_000))
    };
  }

  const key = rateLimitKey(input.namespace, input.identifier);
  const member = `${nowMs}:${randomUUID()}`;
  const windowMs = windowSeconds * 1_000;
  const result = await getRedisConnection().eval(
    `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local window = tonumber(ARGV[2])
      local limit = tonumber(ARGV[3])
      local member = ARGV[4]
      local min = now - window

      redis.call("ZREMRANGEBYSCORE", key, 0, min)
      local count = redis.call("ZCARD", key)
      if count >= limit then
        local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
        local reset = now + window
        if oldest[2] then reset = tonumber(oldest[2]) + window end
        redis.call("PEXPIRE", key, window)
        return {0, limit, 0, reset}
      end

      redis.call("ZADD", key, now, member)
      redis.call("PEXPIRE", key, window)
      return {1, limit, limit - count - 1, now + window}
    `,
    1,
    key,
    nowMs,
    windowMs,
    limit,
    member
  ) as [number, number, number, number];

  const resetAtMs = Number(result[3]);
  return {
    allowed: result[0] === 1,
    limit: Number(result[1]),
    remaining: Number(result[2]),
    resetAt: new Date(resetAtMs),
    retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - nowMs) / 1_000))
  };
}

export * from "./queues";
