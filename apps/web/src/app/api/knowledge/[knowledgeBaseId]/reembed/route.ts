import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { createLocalEmbedding, parseLocalEmbedding } from "@packetchat/files";
import { jsonError, jsonOk } from "../../../../../lib/http";

const MAX_REEMBED_LIMIT = 500;

export async function POST(request: Request, { params }: { params: Promise<{ knowledgeBaseId: string }> }) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { knowledgeBaseId } = await params;
  const body = await request.json().catch(() => null);
  const limit = Math.min(Math.max(Number(body?.limit) || 100, 1), MAX_REEMBED_LIMIT);
  const includeCurrent = body?.includeCurrent === true;
  const scanLimit = includeCurrent ? limit : Math.min(limit * 5, MAX_REEMBED_LIMIT * 5);

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
    content: string;
    embedding: unknown;
  }[]>`
    select kc.id as chunk_id, kc.content, kc.embedding
    from knowledge_chunks kc
    join knowledge_documents kd on kd.id = kc.document_id
    where kd.knowledge_base_id = ${knowledgeBaseId}
      and kd.owner_user_id = ${user.id}
      and kd.ingest_status = 'ready'
    order by kd.created_at asc, kc.chunk_index asc
    limit ${scanLimit}
  `;

  let updated = 0;
  let skippedCurrent = 0;
  const reasons: Record<string, number> = {};

  await sql.begin(async (tx) => {
    for (const chunk of chunks) {
      if (updated >= limit) break;
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
            metadata = metadata || ${JSON.stringify({ embeddingRefreshedAt: new Date().toISOString() })}::jsonb
        where id = ${chunk.chunk_id}
      `;
      updated += 1;
    }
  });

  return jsonOk({
    knowledgeBaseId,
    scanned: chunks.length,
    updated,
    skippedCurrent,
    reasons,
    hasMore: chunks.length === scanLimit || updated === limit
  });
}
