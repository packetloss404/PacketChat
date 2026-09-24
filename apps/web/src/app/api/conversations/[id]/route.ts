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
  const activeLeafProvided = Object.prototype.hasOwnProperty.call(body, "activeLeafMessageId");
  const activeLeafMessageId =
    activeLeafProvided && typeof body.activeLeafMessageId === "string" && body.activeLeafMessageId.trim()
      ? body.activeLeafMessageId.trim()
      : null;
  if (!title && !archiveRequested && !activeLeafProvided) return jsonError("title, archived, or activeLeafMessageId is required", 400);

  const sql = getSql();
  if (activeLeafMessageId) {
    const owned = await sql<{ id: string }[]>`
      select id from messages
      where id = ${activeLeafMessageId} and conversation_id = ${id} and owner_user_id = ${user.id}
      limit 1
    `;
    if (!owned[0]) return jsonError("Message not found", 404);
  }

  const rows = await sql`
    update conversations
    set title = coalesce(${title}, title),
        archived_at = case
          when ${archiveRequested} and ${Boolean(body.archived)} then now()
          when ${archiveRequested} and not ${Boolean(body.archived)} then null
          else archived_at
        end,
        active_leaf_message_id = case when ${activeLeafProvided} then ${activeLeafMessageId}::uuid else active_leaf_message_id end,
        updated_at = now()
    where id = ${id} and owner_user_id = ${user.id}
    returning id, project_id, title, mode, temporary, archived_at, active_leaf_message_id, created_at, updated_at
  `;
  if (!rows[0]) return jsonError("Conversation not found", 404);

  return jsonOk({ conversation: rows[0] });
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { id } = await context.params;
  const sql = getSql();
  const deleted = await sql.begin(async (tx) => {
    const owned = await tx<{ id: string }[]>`
      select id from conversations where id = ${id} and owner_user_id = ${user.id} limit 1
    `;
    if (!owned[0]) return false;

    // messages cascade from the conversation delete, but deleting the tree
    // explicitly keeps the intent local and independent of FK configuration.
    await tx`
      delete from messages where conversation_id = ${id} and owner_user_id = ${user.id}
    `;
    await tx`
      delete from conversations where id = ${id} and owner_user_id = ${user.id}
    `;
    return true;
  });

  if (!deleted) return jsonError("Conversation not found", 404);

  return jsonOk({ deleted: true });
}
