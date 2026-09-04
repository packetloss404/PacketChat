import { getSql } from "@packetchat/db";
import { getProviderAdapter } from "@packetchat/providers";
import { lookup } from "node:dns/promises";
import { snippetFor, termsFor, textMessageContent } from "./helpers";
import { getEnabledModelBindingForRuntime, getProviderAccountForRuntime } from "./provider-runtime";
import { recordUsage } from "./usage";
import type { AgentRunDeps, AgentRunStepInput, AgentSpec, KnowledgeResult, RunVersion } from "./types";

async function markRunRunning(runId: string) {
  const sql = getSql();
  await sql`
    update agent_runs
    set status = 'running', started_at = now()
    where id = ${runId}
  `;
}

async function markRunWaitingInput(runId: string) {
  const sql = getSql();
  await sql`
    update agent_runs
    set status = 'waiting_input'
    where id = ${runId}
  `;
}

async function markRunCompleted(runId: string) {
  const sql = getSql();
  await sql`
    update agent_runs
    set status = 'completed', ended_at = now()
    where id = ${runId}
  `;
}

async function markRunFailed(input: { runId: string; status: string; errorCode: string; message: string }) {
  const sql = getSql();
  await sql`
    update agent_runs
    set status = ${input.status}, error_code = ${input.errorCode}, error_message = ${input.message}, ended_at = now()
    where id = ${input.runId}
  `;
}

async function addRunEvent(runId: string, eventType: string, payload: Record<string, unknown>) {
  const sql = getSql();
  await sql`
    insert into agent_run_events (run_id, sequence_no, event_type, payload)
    select ${runId}, coalesce(max(sequence_no), 0) + 1, ${eventType}, ${JSON.stringify(payload)}::jsonb
    from agent_run_events
    where run_id = ${runId}
  `;
}

async function addRunStep(input: AgentRunStepInput) {
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`
    insert into agent_run_steps (run_id, sequence_no, step_type, status, name, input, output, ended_at)
    values (
      ${input.runId},
      ${input.sequenceNo},
      ${input.stepType},
      ${input.status},
      ${input.name},
      ${JSON.stringify(input.input ?? {})}::jsonb,
      ${JSON.stringify(input.output ?? {})}::jsonb,
      ${input.status === "running" ? null : new Date()}
    )
    returning id
  `;
  return rows[0]!.id;
}

async function completeStep(stepId: string | null, output: Record<string, unknown>) {
  const sql = getSql();
  await sql`
    update agent_run_steps
    set status = 'completed', output = ${JSON.stringify(output)}::jsonb, ended_at = now()
    where id = ${stepId}
  `;
}

async function failStep(stepId: string | null, message: string) {
  const sql = getSql();
  await sql`
    update agent_run_steps
    set status = 'failed', output = ${JSON.stringify({ error: message })}::jsonb, ended_at = now()
    where id = ${stepId}
  `;
}

async function searchKnowledgeContext(input: { userId: string; runId: string; query: string; knowledgeBaseIds: string[]; limit: number }) {
  const terms = [...new Set(termsFor(input.query))];
  if (terms.length === 0 || input.knowledgeBaseIds.length === 0) return [];

  const sql = getSql();
  const rows = await sql<{
    knowledge_base_id: string;
    knowledge_base_name: string;
    chunk_id: string;
    document_id: string;
    chunk_index: number;
    content: string;
    title: string;
  }[]>`
    select
      kb.id as knowledge_base_id,
      kb.name as knowledge_base_name,
      kc.id as chunk_id,
      kc.document_id,
      kc.chunk_index,
      kc.content,
      kd.title
    from knowledge_chunks kc
    join knowledge_documents kd on kd.id = kc.document_id
    join knowledge_bases kb on kb.id = kd.knowledge_base_id
    where kd.knowledge_base_id = any(${input.knowledgeBaseIds})
      and kb.owner_user_id = ${input.userId}
      and kb.status = 'active'
      and kd.owner_user_id = ${input.userId}
      and kd.ingest_status = 'ready'
    order by kd.created_at desc, kc.chunk_index asc
    limit 2000
  `;

  const results = rows
    .map((chunk) => {
      const content = chunk.content.toLowerCase();
      const title = chunk.title.toLowerCase();
      let score = 0;
      for (const term of terms) {
        score += content.split(term).length - 1;
        score += (title.split(term).length - 1) * 3;
      }
      return { chunk, score };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit)
    .map<KnowledgeResult>(({ chunk, score }) => ({
      knowledgeBaseId: chunk.knowledge_base_id,
      knowledgeBaseName: chunk.knowledge_base_name,
      documentId: chunk.document_id,
      chunkId: chunk.chunk_id,
      chunkIndex: chunk.chunk_index,
      title: chunk.title,
      score,
      snippet: snippetFor(chunk.content, terms),
      citation: `${chunk.title}#chunk-${chunk.chunk_index}`
    }));

  await sql`
    insert into retrieval_runs (owner_user_id, knowledge_base_id, query, results)
    select ${input.userId}, kb_id, ${input.query}, ${JSON.stringify(results)}::jsonb
    from unnest(${input.knowledgeBaseIds}::uuid[]) as kb_id
  `;

  return results;
}

async function fileContextBlock(input: { userId: string; knowledgeBaseIds: string[]; maxChars: number }) {
  if (input.knowledgeBaseIds.length === 0 || input.maxChars <= 0) return "";
  const sql = getSql();
  const rows = await sql<{ title: string; chunk_index: number; content: string }[]>`
    select kd.title, kc.chunk_index, kc.content
    from knowledge_chunks kc
    join knowledge_documents kd on kd.id = kc.document_id
    join knowledge_bases kb on kb.id = kd.knowledge_base_id
    where kd.knowledge_base_id = any(${input.knowledgeBaseIds})
      and kb.owner_user_id = ${input.userId}
      and kb.status = 'active'
      and kd.owner_user_id = ${input.userId}
      and kd.ingest_status = 'ready'
    order by kd.created_at desc, kc.chunk_index asc
    limit 200
  `;
  let used = 0;
  const excerpts = [];
  for (const row of rows) {
    if (used >= input.maxChars) break;
    const excerpt = `[${row.title}#chunk-${row.chunk_index}]\n${row.content.trim()}`;
    const remaining = input.maxChars - used;
    const clipped = excerpt.slice(0, remaining);
    excerpts.push(clipped);
    used += clipped.length;
  }
  return excerpts.length > 0 ? `Persistent file context:\n${excerpts.join("\n\n")}` : "";
}

async function loadChildAgent(input: { agentId: string; ownerUserId: string }) {
  const sql = getSql();
  const rows = await sql<{ name: string; spec: AgentSpec }[]>`
    select a.name, v.spec
    from agents a
    join agent_versions v on v.id = a.published_version_id
    where a.id = ${input.agentId}
      and a.owner_user_id = ${input.ownerUserId}
    limit 1
  `;
  return rows[0] ?? null;
}

async function resolveHost(hostname: string) {
  const records = await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  return records.map((record) => record.address);
}

/**
 * The production ports: postgres, the real provider adapters, DNS and the
 * platform fetch. Same shape as the worker's provider-sync/cleanup adapters.
 */
const databaseDeps: AgentRunDeps = {
  markRunRunning,
  markRunWaitingInput,
  markRunCompleted,
  markRunFailed,
  addRunEvent,
  addRunStep,
  completeStep,
  failStep,
  searchKnowledgeContext,
  fileContextBlock,
  loadProviderAccount: (accountId) => getProviderAccountForRuntime(accountId),
  loadModelBinding: (input) => getEnabledModelBindingForRuntime(input),
  loadChildAgent,
  streamChat: (account, request, options) => getProviderAdapter(account.provider).streamChat(account, request, options),
  recordUsage,
  resolveHost,
  fetch: (url, init) => fetch(url, init)
};

export function createAgentRunDeps(overrides: Partial<AgentRunDeps> = {}): AgentRunDeps {
  return { ...databaseDeps, ...overrides };
}

/**
 * Writes the assistant message and bumps the conversation. Shared so every
 * caller - inline, detached, and the queue worker - records exactly the same
 * thing. A run with no conversation writes nothing.
 */
export async function recordRunOutcome(input: {
  conversationId: string | null;
  runId: string;
  userId: string;
  version: RunVersion;
  status: string;
  text: string;
}) {
  if (!input.conversationId) return;
  const sql = getSql();
  await sql.begin(async (tx) => {
    await tx`
      insert into messages (conversation_id, owner_user_id, role, content, metadata)
      values (
        ${input.conversationId},
        ${input.userId},
        'assistant',
        ${JSON.stringify(textMessageContent(input.text))}::jsonb,
        ${JSON.stringify({ agentId: input.version.agent_id, agentName: input.version.agent_name, agentRunId: input.runId, agentMode: "single_pass_augmented", status: input.status })}::jsonb
      )
    `;
    await tx`
      update conversations set updated_at = now() where id = ${input.conversationId} and owner_user_id = ${input.userId}
    `;
  });
}
