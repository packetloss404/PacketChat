import { Queue, Worker, type Processor } from "bullmq";
import IORedis from "ioredis";
export declare const queueNames: {
    readonly providerSync: "provider-sync";
    readonly fileIngestion: "file-ingestion";
    readonly agentRun: "agent-run";
    readonly cleanup: "cleanup";
};
export type FileIngestionJob = {
    documentId: string;
    knowledgeBaseId: string;
    ownerUserId: string;
    attachmentId: string;
};
export declare function getRedisConnection(): IORedis;
export declare function createQueue(name: string): Queue;
export declare function getQueue(name: string): Queue;
export declare function enqueueFileIngestionJob(input: FileIngestionJob): Promise<import("bullmq").Job<any, any, string>>;
export declare function createWorker<T>(name: string, handler: Processor<T>): Worker<T>;
export declare function checkRedis(): Promise<void>;
//# sourceMappingURL=index.d.ts.map