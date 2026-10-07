import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { recordRunOutcome } from "@packetchat/agent-runtime";
import { getAgentAccess } from "../../../../../../lib/agent-access";
import { jsonError, jsonOk } from "../../../../../../lib/http";

type RouteContext = { params: Promise<{ agentId: string; runId: string }> };

type AgentRunUsageRow = {
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

// Legacy fallback for runs created before leases existed. New executors renew a
// 30-second lease; queued runs have neither clock and are never reaped.
const MAX_RUN_AGE_MINUTES = 20;
const ABANDONED_RUN_MESSAGE = "Run stopped because its executor disappeared before completing.";
const CANCELLED_RUN_MESSAGE = "Agent run cancelled by user.";

export async function GET(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { agentId, runId } = await context.params;
  const access = await getAgentAccess(agentId, user);
  if (!access?.canRun) return jsonError("Agent run not found", 404);
  const sql = getSql();
  const runRows = await sql`
    select id, agent_id, agent_version_id, status, input, started_at, ended_at, error_code, error_message, created_at
    from agent_runs
    where id = ${runId} and agent_id = ${agentId} and owner_user_id = ${user.id}
    limit 1
  `;
  if (runRows.length === 0) return jsonError("Agent run not found", 404);

  // A killed worker or in-process fallback can leave a non-terminal row behind.
  // A live executor renews its short lease, so only an expired lease (or a
  // legacy pre-lease row past the old cap) is recovered here.
  const stranded = await sql<{
    id: string;
    conversation_id: string | null;
    owner_user_id: string;
    user_message_id: string | null;
  }[]>`
    update agent_runs
    set status = 'timed_out',
        ended_at = now(),
        heartbeat_at = null,
        lease_expires_at = null,
        error_code = coalesce(error_code, 'run_abandoned'),
        error_message = coalesce(error_message, ${ABANDONED_RUN_MESSAGE})
    where id = ${runId}
      and status in ('preparing', 'running')
      and started_at is not null
      and (
        lease_expires_at < now()
        or (
          lease_expires_at is null
          and started_at < now() - ${`${MAX_RUN_AGE_MINUTES} minutes`}::interval
        )
      )
    returning id, conversation_id, owner_user_id, user_message_id
  `;
  if (stranded[0]) {
    await sql`
      update agent_run_steps
      set status = 'failed',
          output = coalesce(output, '{}'::jsonb) || ${JSON.stringify({ error: ABANDONED_RUN_MESSAGE })}::jsonb,
          ended_at = now()
      where run_id = ${runId} and status = 'running'
    `;
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${'agent-run-event:' + runId}, 0))`;
      await tx`
        insert into agent_run_events (run_id, sequence_no, event_type, payload)
        select ${runId}, coalesce(max(sequence_no), 0) + 1, 'run.failed', ${JSON.stringify({ message: ABANDONED_RUN_MESSAGE, reason: "lease_expired" })}::jsonb
        from agent_run_events
        where run_id = ${runId}
      `;
    });
    const agentRows = await sql<{ name: string }[]>`select name from agents where id = ${agentId} limit 1`;
    await recordRunOutcome({
      conversationId: stranded[0].conversation_id,
      runId,
      userId: stranded[0].owner_user_id,
      version: { agent_id: agentId, agent_name: agentRows[0]?.name ?? "Agent" },
      status: "timed_out",
      text: `Error: ${ABANDONED_RUN_MESSAGE}`,
      userMessageId: stranded[0].user_message_id
    });
  }

  const refreshedRows = stranded[0]
    ? await sql`
        select id, agent_id, agent_version_id, status, input, started_at, ended_at, error_code, error_message, created_at,
               cancel_requested_at, heartbeat_at, lease_expires_at
        from agent_runs
        where id = ${runId}
        limit 1
      `
    : [];
  const run = refreshedRows[0] ?? runRows[0];

  const steps = await sql`
    select id, parent_step_id, sequence_no, step_type, status, name, input, output, started_at, ended_at
    from agent_run_steps
    where run_id = ${runId}
    order by sequence_no asc
  `;
  const events = await sql`
    select id, sequence_no, event_type, payload, created_at
    from agent_run_events
    where run_id = ${runId}
    order by sequence_no asc
  `;
  const usageRows = await sql<AgentRunUsageRow[]>`
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
    where ur.agent_run_id = ${runId}
  `;

  return jsonOk({
    run,
    steps,
    events,
    usage: usageRows[0] ?? {
      provider: null,
      model: null,
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      search_queries: 0,
      cost_usd: null,
      usage_count: 0,
      unknown_cost_count: 0,
      estimated_count: 0
    }
  });
}

/**
 * Cancels a run regardless of which process owns it. The database transition is
 * immediate and idempotent; a live executor observes it through its heartbeat
 * and aborts the provider request. Terminal updates in the runtime are fenced,
 * so a late completion cannot overwrite this status.
 */
export async function DELETE(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { agentId, runId } = await context.params;
  const access = await getAgentAccess(agentId, user);
  if (!access?.canRun) return jsonError("Agent run not found", 404);
  const sql = getSql();

  const cancelled = await sql<{
    id: string;
    status: string;
    conversation_id: string | null;
    owner_user_id: string;
    user_message_id: string | null;
    agent_name: string;
  }[]>`
    update agent_runs r
    set status = 'cancelled',
        cancel_requested_at = coalesce(cancel_requested_at, now()),
        ended_at = coalesce(ended_at, now()),
        heartbeat_at = null,
        lease_expires_at = null,
        error_code = coalesce(error_code, 'agent_run_cancelled'),
        error_message = coalesce(error_message, ${CANCELLED_RUN_MESSAGE})
    from agents a
    where r.id = ${runId}
      and r.agent_id = ${agentId}
      and r.owner_user_id = ${user.id}
      and a.id = r.agent_id
      and r.status in ('queued', 'preparing', 'running', 'waiting_input')
    returning r.id, r.status, r.conversation_id, r.owner_user_id, r.user_message_id, a.name as agent_name
  `;

  const existing = cancelled[0] ? cancelled : await sql<{
    id: string;
    status: string;
    conversation_id: string | null;
    owner_user_id: string;
    user_message_id: string | null;
    agent_name: string;
  }[]>`
    select r.id, r.status, r.conversation_id, r.owner_user_id, r.user_message_id, a.name as agent_name
    from agent_runs r
    join agents a on a.id = r.agent_id
    where r.id = ${runId} and r.agent_id = ${agentId} and r.owner_user_id = ${user.id}
    limit 1
  `;
  const run = existing[0];
  if (!run) return jsonError("Agent run not found", 404);

  if (cancelled[0]) {
    await sql`
      update agent_run_steps
      set status = 'cancelled',
          output = coalesce(output, '{}'::jsonb) || ${JSON.stringify({ error: CANCELLED_RUN_MESSAGE })}::jsonb,
          ended_at = now()
      where run_id = ${runId} and status = 'running'
    `;
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${'agent-run-event:' + runId}, 0))`;
      await tx`
        insert into agent_run_events (run_id, sequence_no, event_type, payload)
        select ${runId}, coalesce(max(sequence_no), 0) + 1, 'run.cancelled', ${JSON.stringify({ message: CANCELLED_RUN_MESSAGE, reason: "user_requested" })}::jsonb
        from agent_run_events
        where run_id = ${runId}
      `;
    });
  }

  // Repeat this on an idempotent DELETE of a cancelled run as a repair path if
  // the first request committed the status but lost its connection while
  // writing the conversation outcome. recordRunOutcome itself de-duplicates.
  if (run.status === "cancelled") {
    await recordRunOutcome({
      conversationId: run.conversation_id,
      runId,
      userId: run.owner_user_id,
      version: { agent_id: agentId, agent_name: run.agent_name },
      status: "cancelled",
      text: CANCELLED_RUN_MESSAGE,
      userMessageId: run.user_message_id
    });
  }

  return jsonOk({ runId, status: run.status, cancelled: run.status === "cancelled" });
}
