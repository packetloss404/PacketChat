import { getSql } from "@packetchat/db";
import { analyzeLocalText, rankLocalHybridResults } from "@packetchat/files";
import { getProviderAdapter } from "@packetchat/providers";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { snippetFor, textMessageContent } from "./helpers";
import { getEnabledModelBindingForRuntime, getProviderAccountForRuntime } from "./provider-runtime";
import { recordUsage } from "./usage";
import type { AgentRunDeps, AgentRunStepInput, AgentSpec, KnowledgeResult, RunClaim, RunVersion } from "./types";

async function markRunRunning(runId: string) {
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`
    update agent_runs
    set status = 'running',
        started_at = coalesce(started_at, now()),
        heartbeat_at = now(),
        lease_expires_at = now() + interval '30 seconds'
    where id = ${runId}
      and status in ('queued', 'preparing', 'running')
      and cancel_requested_at is null
    returning id
  `;
  return rows.length > 0;
}

/**
 * Takes ownership of a queued run so exactly one executor runs it.
 *
 * The queue is at-least-once: BullMQ retries a failed attempt and redelivers a
 * stalled one, and a producer whose enqueue timed out may still have landed the
 * job while it falls back to executing in process. Every one of those paths
 * would otherwise re-run markRunRunning and duplicate paid provider calls and
 * run events.
 *
 * This is one statement, not a read followed by a write: the update takes a row
 * lock, and a second claimer that was waiting on that lock re-evaluates the
 * status predicate against the committed row and matches nothing. There is no
 * window between the check and the act for a second executor to slip into.
 *
 * Only 'queued' and 'preparing' are claimable. 'running' is left alone because
 * an executor may still be alive behind it; a run whose executor died instead is
 * reconciled by the single-run GET once it outlives the cap.
 */
export async function claimRunForExecution(runId: string): Promise<RunClaim> {
  const sql = getSql();
  const rows = await sql<{ claimed: number; status: string | null }[]>`
    with claimed as (
      update agent_runs
      set status = 'running',
          started_at = now(),
          heartbeat_at = now(),
          lease_expires_at = now() + interval '30 seconds'
      where id = ${runId}
        and status in ('queued', 'preparing')
        and cancel_requested_at is null
      returning id
    )
    select
      (select count(*) from claimed)::integer as claimed,
      -- FOR SHARE, not a plain sub-select: a plain read uses the statement
      -- snapshot and reports the status as it was BEFORE the winning claim, so
      -- the loser of a race is told "queued" for a run that is already running.
      (select status from agent_runs where id = ${runId} for share) as status
  `;
  const row = rows[0];
  if (row && row.claimed > 0) return { claimed: true };
  return { claimed: false, status: row?.status ?? null };
}

/**
 * Renews the executor's short database lease and returns durable cancellation
 * state. This is deliberately independent from BullMQ's Redis lock: the web
 * process can request cancellation and reconcile a dead worker using Postgres,
 * which both execution paths already share.
 */
async function maintainRunLease(runId: string) {
  const sql = getSql();
  const rows = await sql<{ status: string; cancel_requested_at: string | null }[]>`
    update agent_runs
    set heartbeat_at = now(),
        lease_expires_at = now() + interval '30 seconds'
    where id = ${runId}
      and status = 'running'
      and cancel_requested_at is null
    returning status, cancel_requested_at
  `;
  if (rows[0]) return { status: rows[0].status, cancelRequested: false };

  const current = await sql<{ status: string; cancel_requested_at: string | null }[]>`
    select status, cancel_requested_at
    from agent_runs
    where id = ${runId}
    limit 1
  `;
  return {
    status: current[0]?.status ?? null,
    cancelRequested: Boolean(current[0]?.cancel_requested_at) || current[0]?.status === "cancelled"
  };
}

async function markRunWaitingInput(runId: string) {
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`
    update agent_runs
    set status = 'waiting_input', heartbeat_at = null, lease_expires_at = null
    where id = ${runId} and status = 'running' and cancel_requested_at is null
    returning id
  `;
  return rows.length > 0;
}

async function markRunCompleted(runId: string) {
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`
    update agent_runs
    set status = 'completed', ended_at = now(), heartbeat_at = null, lease_expires_at = null
    where id = ${runId} and status = 'running' and cancel_requested_at is null
    returning id
  `;
  return rows.length > 0;
}

async function markRunFailed(input: { runId: string; status: string; errorCode: string; message: string }) {
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`
    update agent_runs
    set status = case when cancel_requested_at is not null then 'cancelled' else ${input.status} end,
        error_code = case when cancel_requested_at is not null then 'agent_run_cancelled' else ${input.errorCode} end,
        error_message = case when cancel_requested_at is not null then 'Agent run cancelled by user.' else ${input.message} end,
        ended_at = now(),
        heartbeat_at = null,
        lease_expires_at = null
    where id = ${input.runId}
      and status in ('queued', 'preparing', 'running')
    returning id
  `;
  return rows.length > 0;
}

async function addRunEvent(runId: string, eventType: string, payload: Record<string, unknown>) {
  const sql = getSql();
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${'agent-run-event:' + runId}, 0))`;
    await tx`
      insert into agent_run_events (run_id, sequence_no, event_type, payload)
      select ${runId}, coalesce(max(sequence_no), 0) + 1, ${eventType}, ${JSON.stringify(payload)}::jsonb
      from agent_run_events
      where run_id = ${runId}
    `;
  });
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

async function failStep(stepId: string | null, message: string, status: "failed" | "cancelled" = "failed") {
  const sql = getSql();
  await sql`
    update agent_run_steps
    set status = ${status}, output = ${JSON.stringify({ error: message })}::jsonb, ended_at = now()
    where id = ${stepId} and status = 'running'
  `;
}

async function searchKnowledgeContext(input: { userId: string; runId: string; query: string; knowledgeBaseIds: string[]; limit: number }) {
  const terms = analyzeLocalText(input.query).uniqueTerms;
  if (terms.length === 0 || input.knowledgeBaseIds.length === 0) return [];

  const sql = getSql();
  const rows = await sql<{
    knowledge_base_id: string;
    knowledge_base_name: string;
    chunk_id: string;
    document_id: string;
    chunk_index: number;
    content: string;
    embedding: unknown;
    title: string;
  }[]>`
    select
      kb.id as knowledge_base_id,
      kb.name as knowledge_base_name,
      kc.id as chunk_id,
      kc.document_id,
      kc.chunk_index,
      kc.content,
      kc.embedding,
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

  const results = rankLocalHybridResults(input.query, rows.map((chunk) => ({
    value: chunk,
    title: chunk.title,
    content: chunk.content,
    embedding: chunk.embedding
  })))
    .slice(0, input.limit)
    .map<KnowledgeResult>(({ value: chunk, score }) => ({
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
  maintainRunLease,
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

const TERMINAL_OUTCOME_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);

export function shouldRecordRunOutcome(existingStatuses: Array<string | null>, nextStatus: string) {
  if (existingStatuses.includes(nextStatus)) return false;
  if (TERMINAL_OUTCOME_STATUSES.has(nextStatus) && existingStatuses.some((status) => TERMINAL_OUTCOME_STATUSES.has(status ?? ""))) {
    return false;
  }
  return true;
}

/**
 * Writes the assistant message and bumps the conversation. Shared so every
 * caller - inline, detached, and the queue worker - records exactly the same
 * thing. A run with no conversation writes nothing.
 *
 * The assistant reply is linked under the run's user turn (the run's
 * `userMessageId`), which is persisted on agent_runs and carried in the queue
 * payload so every caller - inline, detached and the queue worker - can pass it.
 * Only a legacy run created before agent_runs.user_message_id existed falls back
 * to the conversation's active leaf, which the route moved to that user turn
 * when it created the run. The inserted assistant message then becomes the
 * active leaf, mirroring the chat route.
 */
export async function recordRunOutcome(input: {
  conversationId: string | null;
  runId: string;
  userId: string;
  version: RunVersion;
  status: string;
  text: string;
  userMessageId?: string | null;
}) {
  if (!input.conversationId) return;
  const sql = getSql();
  const assistantMessageId = randomUUID();
  await sql.begin(async (tx) => {
    // Cancellation, recovery, and the executor can converge on the terminal
    // state at nearly the same time. Serialize message creation per run and
    // make it idempotent so the conversation receives exactly one answer.
    await tx`select pg_advisory_xact_lock(hashtextextended(${input.runId}, 0))`;
    const existing = await tx<{ id: string; status: string | null }[]>`
      select id, metadata->>'status' as status
      from messages
      where conversation_id = ${input.conversationId}
        and owner_user_id = ${input.userId}
        and role = 'assistant'
        and metadata->>'agentRunId' = ${input.runId}
    `;
    if (!shouldRecordRunOutcome(existing.map((row) => row.status), input.status)) return;

    let parentMessageId = input.userMessageId ?? null;
    if (!parentMessageId) {
      const rows = await tx<{ active_leaf_message_id: string | null }[]>`
        select active_leaf_message_id
        from conversations
        where id = ${input.conversationId} and owner_user_id = ${input.userId}
        limit 1
      `;
      parentMessageId = rows[0]?.active_leaf_message_id ?? null;
    }

    await tx`
      insert into messages (id, conversation_id, owner_user_id, role, content, metadata, parent_message_id)
      values (
        ${assistantMessageId},
        ${input.conversationId},
        ${input.userId},
        'assistant',
        ${JSON.stringify(textMessageContent(input.text))}::jsonb,
        ${JSON.stringify({ agentId: input.version.agent_id, agentName: input.version.agent_name, agentRunId: input.runId, agentMode: "single_pass_augmented", status: input.status })}::jsonb,
        ${parentMessageId}
      )
    `;
    await tx`
      update conversations set active_leaf_message_id = ${assistantMessageId}, updated_at = now() where id = ${input.conversationId} and owner_user_id = ${input.userId}
    `;
  });
}
