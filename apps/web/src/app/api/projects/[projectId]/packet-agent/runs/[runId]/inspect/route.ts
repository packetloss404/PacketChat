import { authenticateRequest, decryptJsonSecret } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import {
  fetchSignedCallback,
  interpretInspectResponse
} from "../../../../../../../../lib/packet-agent";
import { jsonError, jsonOk } from "../../../../../../../../lib/http";

type RouteContext = { params: Promise<{ projectId: string; runId: string }> };

type CallbackRow = { callbacks: Record<string, string> };

export async function GET(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { projectId, runId } = await context.params;
  const sql = getSql();
  const owned = await sql<{ id: string }[]>`select id from projects where id = ${projectId} and owner_user_id = ${user.id} limit 1`;
  if (!owned[0]) return jsonError("Project not found", 404);

  const rows = await sql<CallbackRow[]>`
    select callbacks
    from packet_agent_runs
    where id = ${runId} and project_id = ${projectId} and owner_user_id = ${user.id}
    limit 1
  `;
  const row = rows[0];
  if (!row) return jsonError("Run not found", 404);

  let inspectUrl: string | null = null;
  try {
    const callbacks = decryptJsonSecret<{ open?: string; inspect?: string }>(row.callbacks);
    inspectUrl = callbacks.inspect ?? null;
  } catch {
    return jsonError("Run callbacks are unavailable", 502);
  }
  if (!inspectUrl) return jsonError("This run has no inspect callback", 404);

  const result = await fetchSignedCallback(inspectUrl);
  const outcome = interpretInspectResponse(result.status, result.body);
  if (outcome.expired) return jsonOk(outcome);
  if (!outcome.ok) {
    if (outcome.status === 404) return jsonError(outcome.error, 404);
    return jsonError(outcome.error, 502);
  }
  return jsonOk(outcome);
}
