import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import {
  createLocalEmbedding,
  LOCAL_EMBEDDING_DIMENSIONS,
  LOCAL_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_VERSION,
  parseLocalEmbedding
} from "@packetchat/files";
import { jsonError, jsonOk } from "../../../../../lib/http";

const MAX_REEMBED_LIMIT = 500;

export async function POST(request: Request, { params }: { params: Promise<{ knowledgeBaseId: string }> }) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { knowledgeBaseId } = await params;
  const body = await request.json().catch(() => null);
  const limit = Math.min(Math.max(Number(body?.limit) || 100, 1), MAX_REEMBED_LIMIT);
  const includeCurrent = body?.includeCurrent === true;

  const sql = getSql();
  const knowledgeBases = await sql<{ id: string }[]>`
    select id
    from knowledge_bases
    where id = ${knowledgeBaseId}
      and owner_user_id = ${user.id}
      and status = 'active'
    limit 1
  `;
  if (!knowledgeBases[0]) return jsonError("Knowledge base not found", 404);

  const chunks = await sql<{
    chunk_id: string;
    document_id: string;
    content: string;
    embedding: unknown;
  }[]>`
    select kc.id as chunk_id, kc.document_id, kc.content, kc.embedding
    from knowledge_chunks kc
    join knowledge_documents kd on kd.id = kc.document_id
    where kd.knowledge_base_id = ${knowledgeBaseId}
      and kd.owner_user_id = ${user.id}
      and kd.ingest_status = 'ready'
      and (
        ${includeCurrent}
        or kc.embedding is null
        or jsonb_typeof(kc.embedding) is distinct from 'object'
        or kc.embedding ->> 'model' is distinct from ${LOCAL_EMBEDDING_MODEL}
        or kc.embedding ->> 'version' is distinct from ${LOCAL_EMBEDDING_VERSION}
        or kc.embedding ->> 'dimensions' is distinct from ${String(LOCAL_EMBEDDING_DIMENSIONS)}
        or kc.embedding ->> 'normalized' is distinct from 'true'
        or kc.embedding -> 'vector' is null
        or jsonb_typeof(kc.embedding -> 'vector') is distinct from 'array'
        or case
          when jsonb_typeof(kc.embedding -> 'vector') = 'array' then jsonb_array_length(kc.embedding -> 'vector') <> ${LOCAL_EMBEDDING_DIMENSIONS}
          else true
        end
        or exists (
          select 1
          from jsonb_array_elements(
            case
              when jsonb_typeof(kc.embedding -> 'vector') = 'array' then kc.embedding -> 'vector'
              else '[]'::jsonb
            end
          ) as vector_values(value)
          where jsonb_typeof(vector_values.value) <> 'number'
        )
      )
    order by kd.created_at asc, kc.chunk_index asc
    limit ${limit + 1}
  `;

  let updated = 0;
  let skippedCurrent = 0;
  const reasons: Record<string, number> = {};
  const chunksToUpdate = chunks.slice(0, limit);
  const touchedDocumentIds = new Set<string>();
  const refreshedAt = new Date().toISOString();

  await sql.begin(async (tx) => {
    for (const chunk of chunksToUpdate) {
      const parsed = parseLocalEmbedding(chunk.embedding);
      if (parsed.embedding && !includeCurrent) {
        skippedCurrent += 1;
        continue;
      }

      const reason = parsed.reason ?? (includeCurrent ? "current" : "unknown");
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      await tx`
        update knowledge_chunks
        set embedding = ${JSON.stringify(createLocalEmbedding(chunk.content))}::jsonb,
            metadata = metadata || ${JSON.stringify({
              embeddingModel: LOCAL_EMBEDDING_MODEL,
              embeddingVersion: LOCAL_EMBEDDING_VERSION,
              embeddingRefreshedAt: refreshedAt
            })}::jsonb
        where id = ${chunk.chunk_id}
      `;
      updated += 1;
      touchedDocumentIds.add(chunk.document_id);
    }

    for (const documentId of touchedDocumentIds) {
      await tx`
        update knowledge_documents kd
        set source_metadata = source_metadata || ${JSON.stringify({
          embeddingModel: LOCAL_EMBEDDING_MODEL,
          embeddingVersion: LOCAL_EMBEDDING_VERSION,
          embeddingRefreshedAt: refreshedAt
        })}::jsonb,
            updated_at = now()
        where kd.id = ${documentId}
          and not exists (
            select 1
            from knowledge_chunks remaining
            where remaining.document_id = kd.id
              and remaining.embedding ->> 'version' is distinct from ${LOCAL_EMBEDDING_VERSION}
          )
      `;
    }
  });

  return jsonOk({
    knowledgeBaseId,
    model: LOCAL_EMBEDDING_MODEL,
    version: LOCAL_EMBEDDING_VERSION,
    scanned: chunksToUpdate.length,
    updated,
    skippedCurrent,
    reasons,
    hasMore: chunks.length > limit
  });
}
