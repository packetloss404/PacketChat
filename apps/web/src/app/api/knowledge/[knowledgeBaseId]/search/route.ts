import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { cosineSimilarity, createLocalEmbedding, parseLocalEmbedding } from "@packetchat/files";
import { jsonError, jsonOk } from "../../../../../lib/http";

const MAX_LIMIT = 50;
const MAX_OFFSET = 5_000;
const MAX_CANDIDATES = 2_000;

function termsFor(text: string) {
  return text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
}

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

  const terms = [...new Set(termsFor(query))];
  if (terms.length === 0) return jsonError("query must contain searchable terms", 400);
  const queryEmbedding = createLocalEmbedding(query);

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
    title: string;
    mime_type: string | null;
  }[]>`
    select
      kc.id as chunk_id,
      kc.document_id,
      kc.chunk_index,
      kc.content,
      kc.embedding,
      kd.title,
      kd.mime_type
    from knowledge_chunks kc
    join knowledge_documents kd on kd.id = kc.document_id
    where kd.knowledge_base_id = ${knowledgeBaseId}
      and kd.owner_user_id = ${user.id}
      and kd.ingest_status = 'ready'
    order by kd.created_at desc, kc.chunk_index asc
    limit ${candidateLimit}
  `;

  let missingEmbeddingCount = 0;
  let outdatedEmbeddingCount = 0;
  let invalidEmbeddingCount = 0;

  const rankedResults = chunks
    .map((chunk) => {
      const content = chunk.content.toLowerCase();
      const title = chunk.title.toLowerCase();
      let lexicalScore = 0;
      let matchedTerms = 0;
      for (const term of terms) {
        const contentHits = content.split(term).length - 1;
        const titleHits = title.split(term).length - 1;
        if (contentHits > 0 || titleHits > 0) matchedTerms += 1;
        lexicalScore += contentHits + titleHits * 3;
      }
      const parsedEmbedding = parseLocalEmbedding(chunk.embedding);
      if (!parsedEmbedding.embedding) {
        if (parsedEmbedding.reason === "missing") missingEmbeddingCount += 1;
        if (parsedEmbedding.reason === "outdated") outdatedEmbeddingCount += 1;
        if (parsedEmbedding.reason === "invalid") invalidEmbeddingCount += 1;
      }
      return {
        chunk,
        lexicalScore,
        matchedTerms,
        semanticScore: parsedEmbedding.embedding ? Math.max(0, cosineSimilarity(parsedEmbedding.embedding, queryEmbedding)) : 0,
        embeddingStatus: parsedEmbedding.embedding ? "current" : parsedEmbedding.reason ?? "invalid"
      };
    })
    .filter((result) => result.lexicalScore > 0 || result.semanticScore > 0)
    .map((result) => ({
      ...result,
      lexicalNormalized: Math.min(1, Math.log1p(result.lexicalScore) / Math.log1p(terms.length * 4)),
      coverageScore: result.matchedTerms / terms.length
    }))
    .map((result) => ({
      ...result,
      score: result.lexicalNormalized * 0.4 + result.coverageScore * 0.2 + result.semanticScore * 0.4
    }))
    .sort((a, b) => b.score - a.score)
    .map(({ chunk, score, lexicalScore, semanticScore, coverageScore, embeddingStatus }) => ({
      documentId: chunk.document_id,
      chunkId: chunk.chunk_id,
      chunkIndex: chunk.chunk_index,
      title: chunk.title,
      mimeType: chunk.mime_type,
      score: Number(score.toFixed(4)),
      lexicalScore,
      semanticScore: Number(semanticScore.toFixed(4)),
      coverageScore: Number(coverageScore.toFixed(4)),
      embeddingStatus,
      snippet: snippetFor(chunk.content, terms),
      citation: `${chunk.title}#chunk-${chunk.chunk_index}`
    }));

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
      candidateLimit
    },
    embeddings: {
      fallback: missingEmbeddingCount + outdatedEmbeddingCount + invalidEmbeddingCount > 0,
      missing: missingEmbeddingCount,
      outdated: outdatedEmbeddingCount,
      invalid: invalidEmbeddingCount
    }
  });
}
