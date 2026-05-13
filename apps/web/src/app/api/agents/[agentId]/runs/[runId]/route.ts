import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { getAgentAccess } from "../../../../../../lib/agent-access";
import { jsonError, jsonOk } from "../../../../../../lib/http";

type RouteContext = { params: Promise<{ agentId: string; runId: string }> };

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

  return jsonOk({ run: runRows[0], steps, events });
}
