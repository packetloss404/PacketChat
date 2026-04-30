import { createWorker, queueNames, type FileIngestionJob } from "@packetchat/jobs";
import { checkDatabase, getSql } from "@packetchat/db";
import { checkObjectStorage, createLocalEmbedding, downloadObject, extractSupportedText, LOCAL_EMBEDDING_VERSION } from "@packetchat/files";
import { checkRedis } from "@packetchat/jobs";
import { logger } from "@packetchat/observability";

const CHUNK_WORDS = 350;
const CHUNK_OVERLAP_WORDS = 50;

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

async function ingestFile(jobData: FileIngestionJob) {
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

    const bytes = await downloadObject(document.bucket, document.object_key);
    const extracted = await extractSupportedText({
      bytes,
      fileName: document.file_name || document.title,
      mimeType: document.mime_type
    });
    const chunks = chunkText(extracted.text);
    if (chunks.length === 0) throw new Error("No text content could be extracted from this file");

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
            ${JSON.stringify({ startWord: chunk.startWord, endWord: chunk.endWord, detectedType: extracted.detectedType, embeddingVersion: LOCAL_EMBEDDING_VERSION })}::jsonb
          )
        `;
      }
      await tx`
        update knowledge_documents
        set ingest_status = 'ready',
            source_metadata = source_metadata || ${JSON.stringify({ chunkCount: chunks.length, detectedType: extracted.detectedType, embeddingVersion: LOCAL_EMBEDDING_VERSION })}::jsonb,
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

  createWorker(queueNames.providerSync, async (job) => {
    logger.info("Provider sync job received", { jobId: job.id, name: job.name });
  });

  createWorker<FileIngestionJob>(queueNames.fileIngestion, async (job) => {
    logger.info("File ingestion job received", { jobId: job.id, name: job.name });
    await ingestFile(job.data);
  });

  createWorker(queueNames.agentRun, async (job) => {
    logger.info("Agent run job received", { jobId: job.id, name: job.name });
  });

  createWorker(queueNames.cleanup, async (job) => {
    logger.info("Cleanup job received", { jobId: job.id, name: job.name });
  });

  logger.info("PacketChat worker started", { queues: Object.values(queueNames) });
}

main().catch((error) => {
  logger.error("PacketChat worker failed to start", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});

process.on("SIGTERM", () => {
  logger.info("PacketChat worker received SIGTERM");
  process.exit(0);
});
