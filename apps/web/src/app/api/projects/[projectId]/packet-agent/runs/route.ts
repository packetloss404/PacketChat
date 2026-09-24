import { randomUUID } from "node:crypto";
import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import {
  callPacketAgentJson,
  packetAgentRateLimit,
  runViewFromRow,
  sanitizeAgentPayload,
  type PacketAgentConnectionRow,
  type PacketAgentRunRow
} from "../../../../../../lib/packet-agent";
import { jsonError, jsonOk } from "../../../../../../lib/http";

type RouteContext = { params: Promise<{ projectId: string }> };

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export async function GET(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { projectId } = await context.params;
  const sql = getSql();
  const owned = await sql<{ id: string }[]>`select id from projects where id = ${projectId} and owner_user_id = ${user.id} limit 1`;
  if (!owned[0]) return jsonError("Project not found", 404);

  const rows = await sql<PacketAgentRunRow[]>`
    select
      id, connection_id, project_id, owner_user_id, workspace_id, thread_key,
      worker_run_id, worker_definition_id, worker_deployment_id, worker_version_id,
      worker_version_content_digest, title, summary, state, budget, checkpoint,
      required_action, evidence, created_at, updated_at
    from packet_agent_runs
    where project_id = ${projectId} and owner_user_id = ${user.id}
    order by updated_at desc
    limit 50
  `;

  return jsonOk({ runs: rows.map(runViewFromRow) });
}

export async function POST(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);
  const limited = await packetAgentRateLimit(request, user.id);
  if (limited) return limited;

  const { projectId } = await context.params;
  const sql = getSql();
  const owned = await sql<{ id: string }[]>`select id from projects where id = ${projectId} and owner_user_id = ${user.id} limit 1`;
  if (!owned[0]) return jsonError("Project not found", 404);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonError("Invalid request body", 400);
  const connectionId = text(body.connectionId);
  if (!connectionId) return jsonError("connectionId is required", 400);

  const connections = await sql<PacketAgentConnectionRow[]>`
    select
      id, project_id, owner_user_id, name, workspace_id, deployment_id,
      agent_base_url, agent_credentials, ingest_token_digest, ingest_token_prefix,
      created_at, updated_at, rotated_at
    from packet_agent_connections
    where id = ${connectionId} and project_id = ${projectId} and owner_user_id = ${user.id}
    limit 1
  `;
  const connection = connections[0];
  if (!connection) return jsonError("Connection not found", 404);

  const deploymentId = text(body.deploymentId) ?? connection.deployment_id;
  if (!deploymentId) return jsonError("deploymentId is required (no default is set on the connection)", 400);

  const connectionRef = {
    agentBaseUrl: connection.agent_base_url,
    workspaceId: connection.workspace_id,
    agentCredentials: connection.agent_credentials
  };

  // Read the deployment first so activation can assert the revision it saw.
  // Activating on a stale revision would silently start a different worker
  // version than the one the operator previewed.
  const deploymentPath = `/api/worker-deployments/${encodeURIComponent(deploymentId)}`;
  let deploymentRevision: string | number | undefined;
  try {
    const { response, body: deploymentBody } = await callPacketAgentJson<{
      deployment?: { revision?: string | number };
    }>(connectionRef, deploymentPath, { method: "GET", headers: { accept: "application/json" } });
    if (!response.ok) {
      return jsonError(`PacketAgent deployment lookup failed (${response.status})`, 502);
    }
    deploymentRevision = deploymentBody?.deployment?.revision;
  } catch {
    return jsonError("PacketAgent deployment lookup failed", 502);
  }

  if (deploymentRevision === undefined || deploymentRevision === null) {
    return jsonError("PacketAgent deployment response did not include a revision", 502);
  }

  try {
    const { response, body: activation } = await callPacketAgentJson<Record<string, unknown>>(
      connectionRef,
      `${deploymentPath}/activate`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": randomUUID()
        },
        body: JSON.stringify({
          expectedRevision: deploymentRevision,
          startRun: true,
          input: body.input ?? null
        })
      }
    );
    if (!response.ok) {
      return jsonError(`PacketAgent run activation failed (${response.status})`, 502);
    }
    return jsonOk(
      {
        ok: true,
        connectionId: connection.id,
        deploymentId,
        revision: deploymentRevision,
        result: sanitizeAgentPayload(activation ?? {})
      },
      { status: 201 }
    );
  } catch {
    return jsonError("PacketAgent run activation failed", 502);
  }
}
