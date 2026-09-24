import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../../../../../lib/http";

type RouteContext = { params: Promise<{ projectId: string; connectionId: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { projectId, connectionId } = await context.params;
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`
    delete from packet_agent_connections
    where id = ${connectionId} and project_id = ${projectId} and owner_user_id = ${user.id}
    returning id
  `;
  if (!rows[0]) return jsonError("Connection not found", 404);

  return jsonOk({ deleted: true });
}
