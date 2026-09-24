import { authenticateRequest } from "@packetchat/auth";
import {
  buildActivePath,
  contentToText,
  conversationExportFilename,
  parseConversationExportFormat,
  serializeConversationExport,
  type ChatTreeMessage,
  type ConversationExportFormat
} from "@packetchat/contracts";
import { getSql } from "@packetchat/db";
import { jsonError } from "../../../../../lib/http";

type RouteContext = {
  params: Promise<{ id: string }>;
};

const contentTypes: Record<ConversationExportFormat, string> = {
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8"
};

export async function GET(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { id } = await context.params;
  const url = new URL(request.url);
  const format = parseConversationExportFormat(url.searchParams.get("format"));
  if (!format) return jsonError("format must be one of md, json, txt", 400);

  const sql = getSql();
  const conversations = await sql<{ id: string; title: string; active_leaf_message_id: string | null }[]>`
    select id, title, active_leaf_message_id
    from conversations
    where id = ${id} and owner_user_id = ${user.id}
    limit 1
  `;
  if (!conversations[0]) return jsonError("Conversation not found", 404);

  const rows = await sql<{ id: string; role: string; content: unknown; parent_message_id: string | null; created_at: string }[]>`
    select id, role, content, parent_message_id, created_at
    from messages
    where conversation_id = ${id} and owner_user_id = ${user.id}
    order by created_at asc
  `;

  const treeMessages: ChatTreeMessage[] = rows.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    text: contentToText(message.content),
    parentMessageId: message.parent_message_id ?? null,
    createdAt: message.created_at
  }));

  const activePath = buildActivePath(treeMessages, conversations[0].active_leaf_message_id);
  const body = serializeConversationExport({
    conversationId: conversations[0].id,
    title: conversations[0].title,
    messages: activePath,
    format
  });
  const filename = conversationExportFilename(conversations[0].title, conversations[0].id, format);

  return new Response(body, {
    headers: {
      "content-type": contentTypes[format],
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}
