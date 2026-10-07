import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import {
  analyzeLocalText,
  LOCAL_EMBEDDING_PROFILE,
  LOCAL_RETRIEVAL_STRATEGY,
  parseLocalEmbedding,
  rankLocalHybridResults
} from "@packetchat/files";
import { jsonError, jsonOk } from "../../../../../lib/http";

const MAX_LIMIT = 50;
const MAX_OFFSET = 5_000;
const MAX_CANDIDATES = 2_000;

function snippetFor(content: string, terms: string[]) {
  const lower = content.toLowerCase();
  const firstHit = terms.reduce((best, term) => {
    const index = lower.indexOf(term);
    return index >= 0 && index < best ? index : best;
  }, Number.POSITIVE_INFINITY);
  const start = Number.isFinite(firstHit) ? Math.max(0, firstHit - 140) : 0;
  const snippet = content.slice(start, start + 360).trim();
  return `${start > 0 ? "..." : ""}${snippet}${start + 360 < content.length ? "..." : ""}`;
}

export async function POST(request: Request, { params }: { params: Promise<{ knowledgeBaseId: string }> }) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { knowledgeBaseId } = await params;
  const body = await request.json().catch(() => null);
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  const limit = Math.min(Math.max(Number(body?.limit) || 5, 1), MAX_LIMIT);
  const offset = Math.min(Math.max(Number(body?.offset) || 0, 0), MAX_OFFSET);
  const candidateLimit = Math.min(Math.max(Number(body?.candidateLimit) || MAX_CANDIDATES, limit + offset, 100), MAX_CANDIDATES);
  if (!query) return jsonError("query is required", 400);

  const queryAnalysis = analyzeLocalText(query);
  const terms = queryAnalysis.uniqueTerms;
  const queryConceptCount = queryAnalysis.uniqueCanonicalTerms.length;
  if (terms.length === 0) return jsonError("query must contain searchable terms", 400);

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
    chunk_index: number;
    content: string;
    embedding: unknown;
    chunk_metadata: Record<string, unknown> | null;
    token_count: number | null;
    chunk_created_at: string;
    title: string;
    mime_type: string | null;
    attachment_id: string | null;
    document_created_at: string;
    document_updated_at: string;
    source_metadata: Record<string, unknown> | null;
    file_name: string | null;
    size_bytes: string | number | null;
  }[]>`
    select
      kc.id as chunk_id,
      kc.document_id,
      kc.chunk_index,
      kc.content,
      kc.embedding,
      kc.metadata as chunk_metadata,
      kc.token_count,
      kc.created_at as chunk_created_at,
      kd.title,
      kd.mime_type,
      kd.attachment_id,
      kd.created_at as document_created_at,
      kd.updated_at as document_updated_at,
      kd.source_metadata,
      a.file_name,
      a.size_bytes
    from knowledge_chunks kc
    join knowledge_documents kd on kd.id = kc.document_id
    left join attachments a on a.id = kd.attachment_id and a.owner_user_id = kd.owner_user_id
    where kd.knowledge_base_id = ${knowledgeBaseId}
      and kd.owner_user_id = ${user.id}
      and kd.ingest_status = 'ready'
    order by kd.updated_at desc, kd.id asc, kc.chunk_index asc, kc.id asc
    limit ${candidateLimit + 1}
  `;

  const candidateSetTruncated = chunks.length > candidateLimit;
  const candidates = chunks.slice(0, candidateLimit);

  let missingEmbeddingCount = 0;
  let outdatedEmbeddingCount = 0;
  let invalidEmbeddingCount = 0;

  for (const chunk of candidates) {
    const parsedEmbedding = parseLocalEmbedding(chunk.embedding);
    if (parsedEmbedding.embedding) continue;
    if (parsedEmbedding.reason === "missing") missingEmbeddingCount += 1;
    if (parsedEmbedding.reason === "outdated") outdatedEmbeddingCount += 1;
    if (parsedEmbedding.reason === "invalid") invalidEmbeddingCount += 1;
  }

  const rankedResults = rankLocalHybridResults(query, candidates.map((chunk) => ({
    value: chunk,
    title: chunk.title,
    content: chunk.content,
    embedding: chunk.embedding
  }))).map(({ value: chunk, score, lexicalScore, relatednessScore, coverageScore, phraseScore, embeddingStatus, matchedTerms }, index) => {
      const sourceMetadata = chunk.source_metadata && typeof chunk.source_metadata === "object" ? chunk.source_metadata : {};
      const chunkMetadata = chunk.chunk_metadata && typeof chunk.chunk_metadata === "object" ? chunk.chunk_metadata : {};
      const embeddingMetadata = chunk.embedding && typeof chunk.embedding === "object" && !Array.isArray(chunk.embedding) ? chunk.embedding as Record<string, unknown> : {};
      const detectedType = typeof sourceMetadata.detectedType === "string"
        ? sourceMetadata.detectedType
        : typeof chunkMetadata.detectedType === "string"
          ? chunkMetadata.detectedType
          : null;
      const metadataFileName = typeof sourceMetadata.fileName === "string" ? sourceMetadata.fileName : null;
      const metadataSourceName = typeof sourceMetadata.source === "string" ? sourceMetadata.source : null;
      const sourceName = chunk.file_name ?? metadataFileName ?? metadataSourceName ?? chunk.title;
      const ageMs = Date.now() - new Date(chunk.document_updated_at).getTime();
      const ageDays = Number.isFinite(ageMs) ? Math.max(0, Math.floor(ageMs / 86_400_000)) : null;
      const citation = `${chunk.title}#chunk-${chunk.chunk_index}`;
      return {
        documentId: chunk.document_id,
        chunkId: chunk.chunk_id,
        chunkIndex: chunk.chunk_index,
        title: chunk.title,
        mimeType: chunk.mime_type,
        score: Number(score.toFixed(4)),
        lexicalScore: Number(lexicalScore.toFixed(4)),
        relatednessScore: Number(relatednessScore.toFixed(4)),
        coverageScore: Number(coverageScore.toFixed(4)),
        phraseScore: Number(phraseScore.toFixed(4)),
        embeddingStatus,
        matchedTerms,
        source: {
          name: sourceName,
          fileName: chunk.file_name,
          detectedType,
          attachmentId: chunk.attachment_id,
          sizeBytes: chunk.size_bytes,
          createdAt: chunk.document_created_at,
          updatedAt: chunk.document_updated_at,
          metadata: sourceMetadata
        },
        freshness: {
          updatedAt: chunk.document_updated_at,
          chunkCreatedAt: chunk.chunk_created_at,
          embeddingStatus,
          embeddingVersion: typeof embeddingMetadata.version === "string"
            ? embeddingMetadata.version
            : typeof chunkMetadata.embeddingVersion === "string"
              ? chunkMetadata.embeddingVersion
              : typeof sourceMetadata.embeddingVersion === "string"
                ? sourceMetadata.embeddingVersion
                : null,
          embeddingCreatedAt: typeof embeddingMetadata.createdAt === "string" ? embeddingMetadata.createdAt : null,
          embeddingRefreshedAt: typeof chunkMetadata.embeddingRefreshedAt === "string" ? chunkMetadata.embeddingRefreshedAt : null,
          ageDays,
          label: ageDays === null ? "unknown" : ageDays === 0 ? "updated today" : `${ageDays}d old`
        },
        explanation: [
          `Citation ${citation}`,
          `Matched ${matchedTerms.length}/${queryConceptCount} query concepts${matchedTerms.length ? `: ${matchedTerms.join(", ")}` : ""}`,
          `Rank #${index + 1} with BM25 ${Number(lexicalScore.toFixed(4))}`,
          `local relatedness ${Number(relatednessScore.toFixed(4))}`,
          `coverage ${Number(coverageScore.toFixed(4))}`,
          `phrase ${Number(phraseScore.toFixed(4))}`,
          `embedding ${embeddingStatus}`
        ].join(" | "),
        snippet: snippetFor(chunk.content, terms),
        citation
      };
    });

  const results = rankedResults.slice(offset, offset + limit);

  await sql`
    insert into retrieval_runs (owner_user_id, knowledge_base_id, query, results)
    values (${user.id}, ${knowledgeBaseId}, ${query}, ${JSON.stringify(results)}::jsonb)
  `;

  return jsonOk({
    query,
    results,
    pagination: {
      limit,
      offset,
      total: rankedResults.length,
      hasMore: offset + limit < rankedResults.length,
      candidateLimit,
      candidatesScanned: candidates.length,
      candidateSetTruncated
    },
    ranking: {
      strategy: LOCAL_RETRIEVAL_STRATEGY,
      mode: "private-local-hybrid",
      neuralSemantic: LOCAL_EMBEDDING_PROFILE.neuralSemantic,
      capabilities: LOCAL_EMBEDDING_PROFILE.capabilities,
      candidateSetTruncated
    },
    embeddings: {
      model: LOCAL_EMBEDDING_PROFILE.model,
      version: LOCAL_EMBEDDING_PROFILE.version,
      dimensions: LOCAL_EMBEDDING_PROFILE.dimensions,
      kind: LOCAL_EMBEDDING_PROFILE.kind,
      fallback: missingEmbeddingCount + outdatedEmbeddingCount + invalidEmbeddingCount > 0,
      missing: missingEmbeddingCount,
      outdated: outdatedEmbeddingCount,
      invalid: invalidEmbeddingCount
    }
  });
}
