import { randomUUID } from "node:crypto";
import { authenticateRequest, encryptJsonSecret } from "@packetchat/auth";
import { packetAgentRouteConfigTemplate } from "@packetchat/contracts";
import { getSql } from "@packetchat/db";
import {
  buildIngestEndpointUrl,
  connectionMetadataFromRow,
  createIngestToken,
  normalizeAgentBaseUrl,
  type PacketAgentConnectionRow
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

  const rows = await sql<PacketAgentConnectionRow[]>`
    select
      id, project_id, owner_user_id, name, workspace_id, deployment_id,
      agent_base_url, agent_credentials, ingest_token_digest, ingest_token_prefix,
      created_at, updated_at, rotated_at
    from packet_agent_connections
    where project_id = ${projectId} and owner_user_id = ${user.id}
    order by created_at desc
  `;

  return jsonOk({ connections: rows.map(connectionMetadataFromRow) });
}

export async function POST(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { projectId } = await context.params;
  const sql = getSql();
  const owned = await sql<{ id: string }[]>`select id from projects where id = ${projectId} and owner_user_id = ${user.id} limit 1`;
  if (!owned[0]) return jsonError("Project not found", 404);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonError("Invalid request body", 400);

  const name = text(body.name);
  if (!name) return jsonError("name is required", 400);
  const workspaceId = text(body.workspaceId);
  if (!workspaceId) return jsonError("workspaceId is required", 400);
  const agentToken = text(body.agentToken);
  if (!agentToken) return jsonError("agentToken is required", 400);

  const agentBaseUrl = normalizeAgentBaseUrl(body.agentBaseUrl);
  if (!agentBaseUrl) return jsonError("agentBaseUrl must be an http(s) origin with no userinfo, query, or hash", 400);

  const deploymentId = text(body.deploymentId);

  const connectionId = randomUUID();
  const ingest = createIngestToken(connectionId);
  const credentials = encryptJsonSecret({ token: agentToken, workspaceId });

  let inserted: PacketAgentConnectionRow[];
  try {
    inserted = await sql<PacketAgentConnectionRow[]>`
      insert into packet_agent_connections (
        id, project_id, owner_user_id, name, workspace_id, deployment_id,
        agent_base_url, agent_credentials, ingest_token_digest, ingest_token_prefix
      ) values (
        ${connectionId}, ${projectId}, ${user.id}, ${name}, ${workspaceId}, ${deploymentId},
        ${agentBaseUrl}, ${sql.json(credentials)}, ${ingest.digest}, ${ingest.prefix}
      )
      returning
        id, project_id, owner_user_id, name, workspace_id, deployment_id,
        agent_base_url, agent_credentials, ingest_token_digest, ingest_token_prefix,
        created_at, updated_at, rotated_at
    `;
  } catch (error) {
    if (isUniqueViolation(error)) return jsonError("A connection for this workspace already exists on the project", 409);
    throw error;
  }

  const row = inserted[0]!;
  const endpointUrl = buildIngestEndpointUrl();

  return jsonOk(
    {
      connection: connectionMetadataFromRow(row),
      // The raw ingest token is returned exactly once, at creation or rotation.
      ingestToken: { token: ingest.token, prefix: ingest.prefix },
      endpointUrl,
      routeConfig: packetAgentRouteConfigTemplate({ endpoint: endpointUrl, bearerToken: ingest.token })
    },
    { status: 201 }
  );
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505";
}
