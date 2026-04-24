import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../../lib/http";

type RouteContext = { params: Promise<{ knowledgeBaseId: string }> };

function optionalText(value: unknown) {
  if (value === undefined) return undefined;
  if (value == null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { knowledgeBaseId } = await context.params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonError("Invalid request body", 400);

  const name = optionalText(body.name);
  if (name === null) return jsonError("name cannot be empty", 400);
  const description = optionalText(body.description);
  const status = body.status === "active" || body.status === "archived" ? body.status : undefined;
  const archived = typeof body.archived === "boolean" ? (body.archived ? "archived" : "active") : undefined;
  const nextStatus = archived ?? status;
  const nextName = name ?? null;
  const nextDescription = description === undefined ? null : description;
  const statusValue = nextStatus ?? null;

  const sql = getSql();
  const rows = await sql`
    update knowledge_bases
    set name = coalesce(${nextName}, name),
        description = case when ${description !== undefined} then ${nextDescription} else description end,
        status = coalesce(${statusValue}, status),
        updated_at = now()
    where id = ${knowledgeBaseId} and owner_user_id = ${user.id}
    returning id, name, description, status, created_at, updated_at
  `;
  if (!rows[0]) return jsonError("Knowledge base not found", 404);

  return jsonOk({ knowledgeBase: rows[0] });
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { knowledgeBaseId } = await context.params;
  const sql = getSql();
  const rows = await sql`
    delete from knowledge_bases
    where id = ${knowledgeBaseId} and owner_user_id = ${user.id}
    returning id
  `;
  if (!rows[0]) return jsonError("Knowledge base not found", 404);

  return jsonOk({ deleted: true });
}
