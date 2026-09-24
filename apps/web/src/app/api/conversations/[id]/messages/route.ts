import { authenticateRequest } from "@packetchat/auth";
import { contentToText } from "@packetchat/contracts";
import { getSql } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../../../lib/http";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { id } = await context.params;
  const sql = getSql();
  const conversations = await sql<{ id: string; active_leaf_message_id: string | null }[]>`
    select id, active_leaf_message_id
    from conversations
    where id = ${id} and owner_user_id = ${user.id}
    limit 1
  `;
  if (!conversations[0]) return jsonError("Conversation not found", 404);

  const rows = await sql<
    { id: string; role: "user" | "assistant" | "system" | "developer" | "tool"; content: unknown; metadata: unknown; parent_message_id: string | null; created_at: string }[]
  >`
    select id, role, content, metadata, parent_message_id, created_at
    from messages
    where conversation_id = ${id} and owner_user_id = ${user.id}
    order by created_at asc
  `;

  const messages = rows.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    metadata: message.metadata,
    text: contentToText(message.content),
    parentMessageId: message.parent_message_id ?? null,
    createdAt: message.created_at,
    created_at: message.created_at
  }));

  return jsonOk({
    messages,
    activeLeafMessageId: conversations[0].active_leaf_message_id ?? null
  });
}
