import { authenticateRequest } from "@packetchat/auth";
import { packetAgentRouteConfigTemplate } from "@packetchat/contracts";
import { getSql } from "@packetchat/db";
import {
  buildIngestEndpointUrl,
  connectionMetadataFromRow,
  createIngestToken,
  type PacketAgentConnectionRow
} from "../../../../../../../../lib/packet-agent";
import { jsonError, jsonOk } from "../../../../../../../../lib/http";

type RouteContext = { params: Promise<{ projectId: string; connectionId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { projectId, connectionId } = await context.params;
  const sql = getSql();
  const owned = await sql<{ id: string }[]>`select id from projects where id = ${projectId} and owner_user_id = ${user.id} limit 1`;
  if (!owned[0]) return jsonError("Project not found", 404);

  const ingest = createIngestToken(connectionId);
  const rows = await sql<PacketAgentConnectionRow[]>`
    update packet_agent_connections
    set ingest_token_digest = ${ingest.digest},
        ingest_token_prefix = ${ingest.prefix},
        rotated_at = now(),
        updated_at = now()
    where id = ${connectionId} and project_id = ${projectId} and owner_user_id = ${user.id}
    returning
      id, project_id, owner_user_id, name, workspace_id, deployment_id,
      agent_base_url, agent_credentials, ingest_token_digest, ingest_token_prefix,
      created_at, updated_at, rotated_at
  `;
  if (!rows[0]) return jsonError("Connection not found", 404);

  const endpointUrl = buildIngestEndpointUrl();
  return jsonOk({
    connection: connectionMetadataFromRow(rows[0]),
    ingestToken: { token: ingest.token, prefix: ingest.prefix },
    endpointUrl,
    routeConfig: packetAgentRouteConfigTemplate({ endpoint: endpointUrl, bearerToken: ingest.token })
  });
}
