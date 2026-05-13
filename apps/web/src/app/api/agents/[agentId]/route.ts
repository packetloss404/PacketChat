import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { getAgentAccess } from "../../../../lib/agent-access";
import { jsonError, jsonOk } from "../../../../lib/http";

type RouteContext = { params: Promise<{ agentId: string }> };

function optionalText(value: unknown) {
  if (value === undefined) return undefined;
  if (value == null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function GET(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { agentId } = await context.params;
  const access = await getAgentAccess(agentId, user);
  if (!access?.canView) return jsonError("Agent not found", 404);

  const sql = getSql();
  const rows = await sql`
    select
      id,
      name,
      description,
      status,
      current_draft_id,
      published_version_id,
      created_at,
      updated_at,
      ${access.accessRole} as access_role,
      ${access.ownerUserId === user.id} as is_owner
    from agents
    where id = ${agentId}
    limit 1
  `;
  if (!rows[0]) return jsonError("Agent not found", 404);

  return jsonOk({ agent: rows[0] });
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { agentId } = await context.params;
  const access = await getAgentAccess(agentId, user);
  if (!access?.canEdit) return jsonError("Agent not found", 404);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonError("Invalid request body", 400);

  const name = optionalText(body.name);
  if (name === null) return jsonError("name cannot be empty", 400);
  const description = optionalText(body.description);
  const status = body.status === "draft" || body.status === "active" || body.status === "archived" ? body.status : undefined;
  const archived = typeof body.archived === "boolean" ? (body.archived ? "archived" : undefined) : undefined;
  const nextName = name ?? null;
  const nextDescription = description === undefined ? null : description;
  const nextStatus = archived ?? status ?? null;

  const sql = getSql();
  const rows = await sql`
    update agents
    set name = coalesce(${nextName}, name),
        description = case when ${description !== undefined} then ${nextDescription} else description end,
        status = coalesce(${nextStatus}, status),
        updated_at = now()
    where id = ${agentId}
    returning id, name, description, status, current_draft_id, published_version_id, created_at, updated_at
  `;
  if (!rows[0]) return jsonError("Agent not found", 404);

  return jsonOk({ agent: rows[0] });
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { agentId } = await context.params;
  const access = await getAgentAccess(agentId, user);
  if (!access?.canDelete) return jsonError("Agent not found", 404);
  const sql = getSql();
  const rows = await sql`
    delete from agents
    where id = ${agentId}
    returning id
  `;
  if (!rows[0]) return jsonError("Agent not found", 404);

  return jsonOk({ deleted: true });
}
