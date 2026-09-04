import { CLEANUP_SCHEDULE_ID, CLEANUP_SCHEDULE_PATTERN, createWorker, jobNames, queueNames, registerCleanupSchedule, type AgentRunJob, type CleanupJob, type FileIngestionJob, type ProviderSyncJob } from "@packetchat/jobs";
import { assertKnownJobName } from "./job-router";
import type { CleanupTarget } from "./cleanup";
import { runCleanupJob } from "./cleanup-job";
import { runAgentRunJob } from "./agent-run";
import { createAgentRunJobDeps } from "./agent-run-deps";
import { runProviderSync } from "./provider-sync";
import { createProviderSyncDeps } from "./provider-sync-deps";
import { MAX_RUN_EXECUTION_MS } from "@packetchat/agent-runtime";
import { getConfig } from "@packetchat/config";
import { checkDatabase, getSql } from "@packetchat/db";
import { checkObjectStorage, createLocalEmbedding, downloadObject, extractSupportedText, LOCAL_EMBEDDING_VERSION, MAX_EXTRACTED_TEXT_CHARS } from "@packetchat/files";
import { checkRedis } from "@packetchat/jobs";
import { logger } from "@packetchat/observability";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "bullmq";

// Compile-time proof that the cleanup queue payload and the worker's cleanup
// targets are the same set of strings. Adding or renaming a target on one side
// without the other stops this file compiling.
// The false branches must be `false`, not `never`: `never` is assignable to
// every type, so AssertTrue<never> compiles and the assertion silently passes
// on exactly the mismatch it exists to catch.
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;
type CleanupTargetsAgree = AssertTrue<SameUnion<Exclude<CleanupJob["target"], "all">, CleanupTarget>>;

const CHUNK_WORDS = 350;
const CHUNK_OVERLAP_WORDS = 50;
const WORKER_HEALTH_PATH = process.env.WORKER_HEALTH_PATH ?? join(tmpdir(), "packetchat-worker-health.json");

function chunkText(text: string) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const chunks: { content: string; tokenCount: number; startWord: number; endWord: number }[] = [];
  for (let start = 0; start < words.length; start += CHUNK_WORDS - CHUNK_OVERLAP_WORDS) {
    const end = Math.min(start + CHUNK_WORDS, words.length);
    chunks.push({
      content: words.slice(start, end).join(" "),
      tokenCount: end - start,
      startWord: start,
      endWord: end
    });
    if (end === words.length) break;
  }

  return chunks;
}

async function markIngestionFailed(input: FileIngestionJob, errorMessage: string) {
  const sql = getSql();
  await sql.begin(async (tx) => {
    await tx`
      update knowledge_documents
      set ingest_status = 'failed',
          source_metadata = source_metadata || ${JSON.stringify({ error: errorMessage })}::jsonb,
          updated_at = now()
      where id = ${input.documentId}
        and owner_user_id = ${input.ownerUserId}
    `;
    await tx`
      update attachments
      set status = 'failed',
          metadata = metadata || ${JSON.stringify({ error: errorMessage })}::jsonb
      where id = ${input.attachmentId}
        and owner_user_id = ${input.ownerUserId}
    `;
  });
}

async function recordJobFailure(input: {
  queueName: string;
  jobName: string;
  jobId?: string;
  errorMessage: string;
  payload: unknown;
}) {
  try {
    const sql = getSql();
    await sql`
      insert into job_failures (queue_name, job_name, job_id, error_message, payload)
      values (
        ${input.queueName},
        ${input.jobName},
        ${input.jobId ?? null},
        ${input.errorMessage},
        ${JSON.stringify(input.payload ?? {})}::jsonb
      )
    `;
  } catch (error) {
    logger.error("Failed to record job failure", {
      queueName: input.queueName,
      jobId: input.jobId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function startHealthHeartbeat() {
  const write = async () => {
    await writeFile(
      WORKER_HEALTH_PATH,
      JSON.stringify({
        ok: true,
        service: "packetchat-worker",
        pid: process.pid,
        ts: new Date().toISOString()
      })
    );
  };

  void write().catch((error) => {
    logger.warn("Worker health heartbeat failed", { error: error instanceof Error ? error.message : String(error) });
  });

  const interval = setInterval(() => {
    void write().catch((error) => {
      logger.warn("Worker health heartbeat failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }, 10_000);
  interval.unref();
}

// Every worker created, so SIGTERM can drain rather than sever in-flight jobs.
const runningWorkers: Worker<never, never, never>[] = [];

function attachFailureRecorder<DataType, ResultType, NameType extends string>(
  queueName: string,
  worker: Worker<DataType, ResultType, NameType>
) {
  runningWorkers.push(worker as unknown as Worker<never, never, never>);
  worker.on("failed", (job, error) => {
    const message = error instanceof Error ? error.message : String(error);
    void recordJobFailure({
      queueName,
      jobName: job?.name ?? "unknown",
      jobId: job?.id,
      errorMessage: message,
      payload: {
        data: job?.data ?? null,
        attemptsMade: job?.attemptsMade ?? null,
        failedReason: job?.failedReason ?? null,
        stacktrace: job?.stacktrace ?? []
      }
    });
  });

  return worker;
}

async function ingestFile(jobData: FileIngestionJob) {
  const config = getConfig();
  const sql = getSql();
  const documents = await sql<{
    id: string;
    owner_user_id: string;
    knowledge_base_id: string;
    attachment_id: string | null;
    title: string;
    mime_type: string | null;
    bucket: string;
    object_key: string;
    file_name: string;
  }[]>`
    select
      kd.id,
      kd.owner_user_id,
      kd.knowledge_base_id,
      kd.attachment_id,
      kd.title,
      kd.mime_type,
      a.bucket,
      a.object_key,
      a.file_name
    from knowledge_documents kd
    join attachments a on a.id = kd.attachment_id
    where kd.id = ${jobData.documentId}
      and kd.owner_user_id = ${jobData.ownerUserId}
      and kd.knowledge_base_id = ${jobData.knowledgeBaseId}
    limit 1
  `;
  const document = documents[0];
  if (!document) throw new Error(`Knowledge document not found: ${jobData.documentId}`);

  try {
    await sql.begin(async (tx) => {
      await tx`
        update knowledge_documents
        set ingest_status = 'processing', updated_at = now()
        where id = ${document.id}
      `;
      await tx`
        update attachments
        set status = 'processing'
        where id = ${jobData.attachmentId}
      `;
    });

    const bytes = await downloadObject(document.bucket, document.object_key, { maxBytes: config.MAX_UPLOAD_BYTES });
    const extracted = await extractSupportedText({
      bytes,
      fileName: document.file_name || document.title,
      mimeType: document.mime_type
    });
    const chunks = chunkText(extracted.text);
    if (chunks.length === 0) throw new Error("No text content could be extracted from this file");
    const extractionMetadata = {
      detectedType: extracted.detectedType,
      embeddingVersion: LOCAL_EMBEDDING_VERSION,
      ...(extracted.truncated ? { extractionTruncated: true, extractionLimitChars: MAX_EXTRACTED_TEXT_CHARS } : {})
    };

    await sql.begin(async (tx) => {
      await tx`delete from knowledge_chunks where document_id = ${document.id}`;
      for (const [index, chunk] of chunks.entries()) {
        await tx`
          insert into knowledge_chunks (document_id, owner_user_id, chunk_index, content, token_count, embedding, metadata)
          values (
            ${document.id},
            ${document.owner_user_id},
            ${index},
            ${chunk.content},
            ${chunk.tokenCount},
            ${JSON.stringify(createLocalEmbedding(chunk.content))}::jsonb,
            ${JSON.stringify({ startWord: chunk.startWord, endWord: chunk.endWord, ...extractionMetadata })}::jsonb
          )
        `;
      }
      await tx`
        update knowledge_documents
        set ingest_status = 'ready',
            source_metadata = source_metadata || ${JSON.stringify({ chunkCount: chunks.length, ...extractionMetadata })}::jsonb,
            updated_at = now()
        where id = ${document.id}
      `;
      await tx`
        update attachments
        set status = 'ready',
            metadata = metadata || ${JSON.stringify({ chunkCount: chunks.length })}::jsonb
        where id = ${jobData.attachmentId}
      `;
    });

    logger.info("File ingestion completed", { documentId: document.id, chunks: chunks.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markIngestionFailed(jobData, message);
    logger.warn("File ingestion failed", { documentId: jobData.documentId, error: message });
    throw error;
  }
}

async function main() {
  await checkDatabase();
  await checkRedis();
  await checkObjectStorage();
  startHealthHeartbeat();

  attachFailureRecorder(queueNames.providerSync, createWorker<ProviderSyncJob>(queueNames.providerSync, async (job) => {
    // Fail loudly on unexpected job names instead of logging a success-like no-op.
    assertKnownJobName(queueNames.providerSync, job.name, [jobNames.providerSync]);
    logger.info("Provider sync job received", { jobId: job.id, name: job.name });

    const providerAccountId = typeof job.data.providerAccountId === "string" ? job.data.providerAccountId.trim() : "";
    if (!providerAccountId) throw new Error("provider-sync job is missing providerAccountId");

    const result = await runProviderSync(providerAccountId, createProviderSyncDeps());
    // runProviderSync reports failure instead of throwing. Rethrow so the job
    // lands in job_failures and BullMQ retries it, rather than completing as a
    // success that synced nothing.
    if (!result.ok) {
      throw new Error(`Provider sync failed for ${providerAccountId}: ${result.error ?? "unknown error"}`);
    }

    logger.info("Provider sync job completed", { jobId: job.id, providerAccountId, modelCount: result.modelCount });
  }));

  attachFailureRecorder(queueNames.fileIngestion, createWorker<FileIngestionJob>(queueNames.fileIngestion, async (job) => {
    assertKnownJobName(queueNames.fileIngestion, job.name, ["ingest-file"]);
    logger.info("File ingestion job received", { jobId: job.id, name: job.name });
    await ingestFile(job.data);
  }));

  attachFailureRecorder(queueNames.agentRun, createWorker<AgentRunJob>(queueNames.agentRun, async (job) => {
    assertKnownJobName(queueNames.agentRun, job.name, [jobNames.agentRun]);
    logger.info("Agent run job received", { jobId: job.id, name: job.name, runId: job.data?.runId });

    // runAgentRunJob throws on everything that stops a run executing, so a
    // failed run lands in job_failures and BullMQ retries it instead of
    // completing as a success that ran nothing. The one quiet outcome is a run
    // another executor already owns.
    const result = await runAgentRunJob(job.data, createAgentRunJobDeps(), { maxRunMs: MAX_RUN_EXECUTION_MS });
    if (!result.executed) {
      logger.info("Agent run job skipped; the run is already claimed", {
        jobId: job.id,
        runId: job.data?.runId,
        status: result.skippedStatus
      });
      return;
    }

    logger.info("Agent run job completed", { jobId: job.id, runId: job.data?.runId, status: result.status });
  }));

  attachFailureRecorder(queueNames.cleanup, createWorker<CleanupJob>(queueNames.cleanup, async (job) => {
    assertKnownJobName(queueNames.cleanup, job.name, [jobNames.cleanup]);
    logger.info("Cleanup job received", { jobId: job.id, name: job.name, target: job.data.target });

    const report = await runCleanupJob(job.data);
    logger.info("Cleanup job completed", {
      jobId: job.id,
      targets: report.targets,
      deleted: report.deleted,
      cutoffs: report.cutoffs
    });
  }));

  try {
    await registerCleanupSchedule();
    logger.info("Cleanup schedule registered", { id: CLEANUP_SCHEDULE_ID, pattern: CLEANUP_SCHEDULE_PATTERN });
  } catch (error) {
    // Retention is not worth crash-looping the worker over: file ingestion and
    // provider sync still run. The missing schedule is logged at error level so
    // it surfaces, and the next boot retries the upsert.
    logger.error("Cleanup schedule registration failed", {
      id: CLEANUP_SCHEDULE_ID,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  logger.info("PacketChat worker started", { queues: Object.values(queueNames) });
}

main().catch((error) => {
  logger.error("PacketChat worker failed to start", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});

// Agent runs can hold a worker for up to fifteen minutes. Exiting immediately
// severed the job mid-flight and left its run row 'running' forever: the claim
// only accepts 'queued'/'preparing', so the redelivered job matched nothing and
// completed as a successful no-op. Closing the workers lets BullMQ finish or
// properly release what is in flight.
//
// Draining is itself bounded, because a wedged provider call must not stop the
// process from ever exiting - the container would then be SIGKILLed anyway, and
// a stalled job is redelivered after its lock expires.
const SHUTDOWN_DRAIN_MS = 20_000;

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("PacketChat worker shutting down", { signal, workers: runningWorkers.length });

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled(runningWorkers.map((worker) => worker.close())),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          logger.warn("Worker drain timed out; exiting anyway", { drainMs: SHUTDOWN_DRAIN_MS });
          resolve();
        }, SHUTDOWN_DRAIN_MS);
      })
    ]);
  } catch (error) {
    logger.error("Worker shutdown failed", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (timer) clearTimeout(timer);
  }

  logger.info("PacketChat worker stopped", { signal });
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
