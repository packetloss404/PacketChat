import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../../lib/http";

type RouteContext = { params: Promise<{ id: string }> };

function titleFrom(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 160) : null;
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonError("Invalid request body", 400);

  const title = titleFrom(body.title);
  const archiveRequested = typeof body.archived === "boolean";
  if (!title && !archiveRequested) return jsonError("title or archived is required", 400);

  const sql = getSql();
  const rows = await sql`
    update conversations
    set title = coalesce(${title}, title),
        archived_at = case
          when ${archiveRequested} and ${Boolean(body.archived)} then now()
          when ${archiveRequested} and not ${Boolean(body.archived)} then null
          else archived_at
        end,
        updated_at = now()
    where id = ${id} and owner_user_id = ${user.id}
    returning id, project_id, title, mode, temporary, archived_at, created_at, updated_at
  `;
  if (!rows[0]) return jsonError("Conversation not found", 404);

  return jsonOk({ conversation: rows[0] });
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { id } = await context.params;
  const sql = getSql();
  const rows = await sql`
    delete from conversations
    where id = ${id} and owner_user_id = ${user.id}
    returning id
  `;
  if (!rows[0]) return jsonError("Conversation not found", 404);

  return jsonOk({ deleted: true });
}
