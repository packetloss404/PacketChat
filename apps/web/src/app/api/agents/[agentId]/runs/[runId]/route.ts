import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
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
    run: runRows[0],
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
