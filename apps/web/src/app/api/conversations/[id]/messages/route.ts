import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../../../lib/http";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function textFromContent(content: unknown) {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part ? String(part.text) : ""))
    .filter(Boolean)
    .join("\n");
}

export async function GET(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { id } = await context.params;
  const sql = getSql();
  const conversations = await sql<{ id: string }[]>`
    select id from conversations where id = ${id} and owner_user_id = ${user.id} limit 1
  `;
  if (!conversations[0]) return jsonError("Conversation not found", 404);

  const rows = await sql<{ id: string; role: "user" | "assistant" | "system" | "developer" | "tool"; content: unknown; metadata: unknown; created_at: string }[]>`
    select id, role, content, metadata, created_at
    from messages
    where conversation_id = ${id} and owner_user_id = ${user.id}
    order by created_at asc
  `;

  const messages = rows.map((message) => ({
    ...message,
    text: textFromContent(message.content)
  }));

  return jsonOk({ messages });
}
