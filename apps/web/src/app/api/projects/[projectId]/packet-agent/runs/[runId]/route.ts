import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import {
  runViewFromRow,
  type PacketAgentRunRow
} from "../../../../../../../lib/packet-agent";
import { jsonError, jsonOk } from "../../../../../../../lib/http";

type RouteContext = { params: Promise<{ projectId: string; runId: string }> };

type EventRow = {
  id: string;
  message_key: string;
  event: string;
  payload: unknown;
  created_at: string;
};

export async function GET(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { projectId, runId } = await context.params;
  const sql = getSql();
  const owned = await sql<{ id: string }[]>`select id from projects where id = ${projectId} and owner_user_id = ${user.id} limit 1`;
  if (!owned[0]) return jsonError("Project not found", 404);

  const runs = await sql<PacketAgentRunRow[]>`
    select
      id, connection_id, project_id, owner_user_id, workspace_id, thread_key,
      worker_run_id, worker_definition_id, worker_deployment_id, worker_version_id,
      worker_version_content_digest, title, summary, state, budget, checkpoint,
      required_action, evidence, created_at, updated_at
    from packet_agent_runs
    where id = ${runId} and project_id = ${projectId} and owner_user_id = ${user.id}
    limit 1
  `;
  const run = runs[0];
  if (!run) return jsonError("Run not found", 404);

  const events = await sql<EventRow[]>`
    select id, message_key, event, payload, created_at
    from packet_agent_run_events
    where run_id = ${runId}
    order by created_at asc
  `;

  return jsonOk({
    run: runViewFromRow(run),
    events: events.map((event) => ({
      id: event.id,
      messageKey: event.message_key,
      event: event.event,
      payload: event.payload,
      createdAt: event.created_at
    }))
  });
}
