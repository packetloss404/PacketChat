import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { logger } from "@packetchat/observability";
import {
  claimRunForExecution,
  createAgentRunDeps,
  executeRun,
  MAX_RUN_EXECUTION_MS,
  publicRunError,
  recordRunOutcome,
  textMessageContent,
  textOrNull,
  type AgentSpec
} from "@packetchat/agent-runtime";
import { enqueueAgentRunJob } from "@packetchat/jobs";
import { jsonError, jsonOk } from "../../../../../lib/http";
import { getAgentAccess } from "../../../../../lib/agent-access";
import { dispatchAgentRun } from "../../../../../lib/agent-run-dispatch";
import { agentRateLimit } from "../../../../../lib/rate-limit";

// resolved_provider_account_id is a uuid column; agent specs are not validated
// as uuids when they are written, so the value is checked before it reaches SQL.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteContext = { params: Promise<{ agentId: string }> };

type AgentRunListRow = {
  id: string;
  agent_id: string;
  agent_version_id: string;
  conversation_id: string | null;
  trigger_type: string;
  status: string;
  input: Record<string, unknown>;
  started_at: string | null;
  ended_at: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  step_count: number;
  event_count: number;
  provider: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  search_queries: number;
  cost_usd: number | null;
  usage_count: number;
  unknown_cost_count: number;
  estimated_count: number;
};

function usageFromRow(row: AgentRunListRow) {
  return {
    provider: row.provider,
    model: row.model,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    reasoning_tokens: row.reasoning_tokens,
    search_queries: row.search_queries,
    cost_usd: row.cost_usd,
    usage_count: row.usage_count,
    unknown_cost_count: row.unknown_cost_count,
    estimated_count: row.estimated_count
  };
}

function titleFromText(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 80) : "New chat";
}

export async function POST(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);
  const rateLimited = await agentRateLimit(request, user.id);
  if (rateLimited) return rateLimited;

  const { agentId } = await context.params;
  const access = await getAgentAccess(agentId, user);
  if (!access?.canRun) return jsonError("Published agent version not found", 404);
  const body = await request.json().catch(() => null);
  // Opt-in so existing callers keep their synchronous contract unchanged.
  const runAsync = body?.async === true || request.headers.get("prefer") === "respond-async";
  const inputText = textOrNull(body?.inputText) ?? textOrNull(body?.input);
  if (!inputText) return jsonError("inputText or input is required", 400);

  const sql = getSql();
  const versionRows = await sql<{ agent_id: string; agent_name: string; version_id: string; spec: AgentSpec; manifest: Record<string, unknown> }[]>`
    select a.id as agent_id, a.name as agent_name, v.id as version_id, v.spec, v.manifest
    from agents a
    join agent_versions v on v.id = a.published_version_id
    where a.id = ${agentId}
    limit 1
  `;
  if (versionRows.length === 0) return jsonError("Published agent version not found", 404);

  const version = versionRows[0]!;
  const providerAccountId = textOrNull(version.spec.providerAccountId);
  const model = textOrNull(version.spec.model);
  if (!providerAccountId) return jsonError("Agent spec is missing providerAccountId. Save and publish a provider account before running.", 400);
  // resolved_provider_account_id is a uuid column and this value comes from an
  // agent spec, which the draft writer does not constrain. Rejecting here keeps
  // a malformed spec a 400 rather than a 22P02 that aborts the insert - which
  // would roll back the conversation and the user's own message with it.
  if (!UUID_PATTERN.test(providerAccountId)) {
    return jsonError("Agent spec has an invalid providerAccountId. Re-select the provider account and publish again.", 400);
  }
  if (!model) return jsonError("Agent spec is missing model. Save and publish a model before running.", 400);

  const requestedConversationId = textOrNull(body?.conversationId);
  const wantsConversation = body?.conversation === true || Boolean(requestedConversationId);
  const setup = await sql.begin(async (tx) => {
    let conversationId: string | null = null;
    if (wantsConversation) {
      if (requestedConversationId) {
        const conversations = await tx<{ id: string }[]>`
          select id
          from conversations
          where id = ${requestedConversationId} and owner_user_id = ${user.id} and archived_at is null
          limit 1
        `;
        if (!conversations[0]) return null;
        conversationId = conversations[0].id;
      } else {
        const conversations = await tx<{ id: string }[]>`
          insert into conversations (owner_user_id, title, mode)
          values (${user.id}, ${`Agent: ${version.agent_name} - ${titleFromText(inputText)}`.slice(0, 160)}, 'agent_test')
          returning id
        `;
        conversationId = conversations[0]!.id;
      }

      await tx`
        insert into messages (conversation_id, owner_user_id, role, content, metadata)
        values (
          ${conversationId},
          ${user.id},
          'user',
          ${JSON.stringify(textMessageContent(inputText))}::jsonb,
          ${JSON.stringify({ agentId: version.agent_id, agentName: version.agent_name, agentMode: "single_pass_augmented" })}::jsonb
        )
      `;

      await tx`
        update conversations set updated_at = now() where id = ${conversationId} and owner_user_id = ${user.id}
      `;
    }

    // An async run is 'queued' until an executor claims it, so the reconcile
    // clock starts when the run actually begins rather than when it was created.
    // The synchronous path still inserts 'running': it begins immediately.
    //
    // The resolved provider account and model are persisted because they are
    // resolved per request. Nothing else records them, and a worker that
    // re-resolved them could run the agent against a different model than this
    // caller asked for.
    const runRows = await tx<{ id: string }[]>`
      insert into agent_runs (owner_user_id, agent_id, agent_version_id, conversation_id, trigger_type, status, input, resolved_manifest, resolved_provider_account_id, resolved_model)
      values (
        ${user.id},
        ${version.agent_id},
        ${version.version_id},
        ${conversationId},
        ${conversationId ? "chat" : "manual"},
        ${runAsync ? "queued" : "running"},
        ${JSON.stringify({ text: inputText })}::jsonb,
        ${JSON.stringify(version.manifest)}::jsonb,
        ${providerAccountId},
        ${model}
      )
      returning id
    `;

    return { conversationId, runId: runRows[0]!.id };
  });
  if (!setup) return jsonError("Conversation not found", 404);
  const { conversationId, runId } = setup;
  // Authorization is done; from here the executor only needs an owner id, so it
  // runs on the same ports the queue worker uses.
  const deps = createAgentRunDeps();
  await deps.addRunEvent(runId, "run.created", { inputText });

  // Async execution: the run keeps going after the response is sent, so it
  // survives the client closing the tab and is not capped by the gateway's
  // request timeout. The caller polls GET /api/agents/{agentId}/runs/{runId}.
  //
  // The queue owns it whenever Redis is reachable, so the run survives a web
  // restart too. When the enqueue fails the run executes in this process
  // instead - degrading beats refusing - which is durable only until this
  // process ends; GET reconciles whatever is left stranded past the cap.
  if (runAsync) {
    const detachedRun = async () => {
      // A timed-out enqueue can still have landed the job, so ownership is taken
      // the same way the worker takes it. Losing the claim means the worker has
      // the run and executing it here as well would duplicate it.
      const claim = await claimRunForExecution(runId);
      if (!claim.claimed) {
        logger.info("Skipping in-process agent run; the run is already claimed", { runId, status: claim.status });
        return;
      }

      const detached = new AbortController();
      const timeout = setTimeout(() => detached.abort(), MAX_RUN_EXECUTION_MS);
      try {
        const result = await executeRun(deps, { runId, resourceOwnerUserId: access.ownerUserId, spec: { ...version.spec, providerAccountId, model }, inputText, signal: detached.signal });
        await recordRunOutcome({ conversationId, runId, userId: user.id, version, status: result.status, text: result.outputText });
      } catch (error) {
        const message = publicRunError(error);
        logger.error("Detached agent run failed", { runId, error: message });
        await recordRunOutcome({ conversationId, runId, userId: user.id, version, status: "failed", text: `Error: ${message}` }).catch(() => {
          // The run row is already marked by executeRun; a failure to write the
          // conversation message must not become an unhandled rejection.
        });
      } finally {
        clearTimeout(timeout);
      }
    };

    await dispatchAgentRun({
      enqueue: () => enqueueAgentRunJob({ runId, agentId: version.agent_id, resourceOwnerUserId: access.ownerUserId }),
      executeDetached: () => {
        void detachedRun().catch((error) => {
          // Only the claim itself can reach here; everything after it is already
          // handled above. An unhandled rejection would take the process down.
          logger.error("Detached agent run could not start", { runId, error: error instanceof Error ? error.message : String(error) });
        });
      }
    }, { runId });

    return jsonOk({ runId, conversationId, status: "queued" }, { status: 202 });
  }

  try {
    const result = await executeRun(deps, { runId, resourceOwnerUserId: access.ownerUserId, spec: { ...version.spec, providerAccountId, model }, inputText, signal: request.signal });
    if (conversationId) {
      await sql.begin(async (tx) => {
        await tx`
          insert into messages (conversation_id, owner_user_id, role, content, metadata)
          values (
            ${conversationId},
            ${user.id},
            'assistant',
            ${JSON.stringify(textMessageContent(result.outputText))}::jsonb,
            ${JSON.stringify({ agentId: version.agent_id, agentName: version.agent_name, agentRunId: runId, agentMode: "single_pass_augmented", status: result.status })}::jsonb
          )
        `;
        await tx`
          update conversations set updated_at = now() where id = ${conversationId} and owner_user_id = ${user.id}
        `;
      });
    }
    return jsonOk({
      runId,
      conversationId,
      status: result.status,
      outputText: result.outputText,
      ...("approvalId" in result ? { approvalId: result.approvalId } : {})
    }, { status: 201 });
  } catch (error) {
    const message = publicRunError(error);
    if (conversationId) {
      await sql.begin(async (tx) => {
        await tx`
          insert into messages (conversation_id, owner_user_id, role, content, metadata)
          values (
            ${conversationId},
            ${user.id},
            'assistant',
            ${JSON.stringify(textMessageContent(`Error: ${message}`))}::jsonb,
            ${JSON.stringify({ agentId: version.agent_id, agentName: version.agent_name, agentRunId: runId, agentMode: "single_pass_augmented", status: "failed" })}::jsonb
          )
        `;
        await tx`
          update conversations set updated_at = now() where id = ${conversationId} and owner_user_id = ${user.id}
        `;
      });
    }
    return jsonOk({ runId, conversationId, status: "failed", error: message }, { status: 201 });
  }
}

export async function GET(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { agentId } = await context.params;
  const access = await getAgentAccess(agentId, user);
  if (!access?.canRun) return jsonError("Agent runs not found", 404);

  const sql = getSql();
  const rows = await sql<AgentRunListRow[]>`
    select
      r.id,
      r.agent_id,
      r.agent_version_id,
      r.conversation_id,
      r.trigger_type,
      r.status,
      r.input,
      r.started_at,
      r.ended_at,
      r.error_code,
      r.error_message,
      r.created_at,
      coalesce(steps.step_count, 0)::integer as step_count,
      coalesce(events.event_count, 0)::integer as event_count,
      usage.provider,
      usage.model,
      coalesce(usage.input_tokens, 0)::integer as input_tokens,
      coalesce(usage.output_tokens, 0)::integer as output_tokens,
      coalesce(usage.reasoning_tokens, 0)::integer as reasoning_tokens,
      coalesce(usage.search_queries, 0)::integer as search_queries,
      usage.cost_usd::float8 as cost_usd,
      coalesce(usage.usage_count, 0)::integer as usage_count,
      coalesce(usage.unknown_cost_count, 0)::integer as unknown_cost_count,
      coalesce(usage.estimated_count, 0)::integer as estimated_count
    from agent_runs r
    left join lateral (
      select count(*)::integer as step_count
      from agent_run_steps ars
      where ars.run_id = r.id
    ) steps on true
    left join lateral (
      select count(*)::integer as event_count
      from agent_run_events arev
      where arev.run_id = r.id
    ) events on true
    left join lateral (
      select
        string_agg(distinct ur.provider, ', ') filter (where ur.provider is not null) as provider,
        string_agg(distinct ur.model, ', ') filter (where ur.model is not null) as model,
        coalesce(sum(ur.input_tokens), 0)::integer as input_tokens,
        coalesce(sum(ur.output_tokens), 0)::integer as output_tokens,
        coalesce(sum(ur.reasoning_tokens), 0)::integer as reasoning_tokens,
        coalesce(sum(ur.search_queries), 0)::integer as search_queries,
        sum(ur.cost_usd)::float8 as cost_usd,
        count(*)::integer as usage_count,
        count(*) filter (where ur.cost_usd is null)::integer as unknown_cost_count,
        count(*) filter (where coalesce((ur.raw_usage->>'estimated')::boolean, false))::integer as estimated_count
      from usage_records ur
      where ur.agent_run_id = r.id
    ) usage on true
    where r.agent_id = ${agentId}
      and r.owner_user_id = ${user.id}
    order by r.created_at desc
    limit 25
  `;

  const runs = rows.map((row) => ({
    id: row.id,
    agent_id: row.agent_id,
    agent_version_id: row.agent_version_id,
    conversation_id: row.conversation_id,
    trigger_type: row.trigger_type,
    status: row.status,
    input: row.input,
    started_at: row.started_at,
    ended_at: row.ended_at,
    error_code: row.error_code,
    error_message: row.error_message,
    created_at: row.created_at,
    step_count: row.step_count,
    event_count: row.event_count,
    usage: usageFromRow(row)
  }));

  return jsonOk({ runs });
}
