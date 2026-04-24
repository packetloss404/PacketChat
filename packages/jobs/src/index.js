import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { getConfig } from "@packetchat/config";
export const queueNames = {
    providerSync: "provider-sync",
    fileIngestion: "file-ingestion",
    agentRun: "agent-run",
    cleanup: "cleanup"
};
let connection;
const queues = new Map();
export function getRedisConnection() {
    if (!connection) {
        connection = new IORedis(getConfig().REDIS_URL, { maxRetriesPerRequest: null });
    }
    return connection;
}
export function createQueue(name) {
    return new Queue(name, { connection: getRedisConnection() });
}
export function getQueue(name) {
    const existing = queues.get(name);
    if (existing)
        return existing;
    const queue = createQueue(name);
    queues.set(name, queue);
    return queue;
}
export async function enqueueFileIngestionJob(input) {
    return getQueue(queueNames.fileIngestion).add("ingest-file", input, {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: 100,
        removeOnFail: 500
    });
}
export function createWorker(name, handler) {
    return new Worker(name, handler, {
        connection: getRedisConnection(),
        concurrency: getConfig().WORKER_CONCURRENCY
    });
}
export async function checkRedis() {
    await getRedisConnection().ping();
}
