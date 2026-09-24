import { buildSharedConversation, contentToText, normalizeShareToken, type ChatTreeMessage } from "@packetchat/contracts";
import { getSql } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../../lib/http";
import { rateLimitResponse } from "../../../../lib/rate-limit";

type RouteContext = { params: Promise<{ token: string }> };

/**
 * Public, unauthenticated read of a shared conversation.
 *
 * The token is the only credential. Unknown and revoked tokens both return 404
 * so the endpoint never reveals whether a private conversation exists. A share
 * whose recorded snapshot leaf was deleted also returns 404 rather than falling
 * back to newer content. The response is narrowed to title, role, text content
 * and timestamps; owner ids, provider/run data and message metadata stay
 * server-side.
 */
export async function GET(request: Request, context: RouteContext) {
  const rateLimited = await rateLimitResponse({ namespace: "share-read", request, limit: 120 });
  if (rateLimited) return rateLimited;

  const { token: rawToken } = await context.params;
  const token = normalizeShareToken(rawToken);
  if (!token) return jsonError("Share link not found", 404);

  const sql = getSql();
  const shares = await sql<{ conversation_id: string; title: string; active_leaf_message_id: string | null }[]>`
    select c.id as conversation_id, c.title, s.active_leaf_message_id
    from conversation_shares s
    join conversations c on c.id = s.conversation_id
    where s.token = ${token} and s.revoked_at is null
    limit 1
  `;
  const share = shares[0];
  if (!share) return jsonError("Share link not found", 404);

  const rows = await sql<{ id: string; role: string; content: unknown; parent_message_id: string | null; created_at: string | Date }[]>`
    select id, role, content, parent_message_id, created_at
    from messages
    where conversation_id = ${share.conversation_id}
    order by created_at asc
  `;

  const tree: ChatTreeMessage[] = rows.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    text: contentToText(message.content),
    parentMessageId: message.parent_message_id ?? null,
    createdAt: message.created_at instanceof Date ? message.created_at.toISOString() : String(message.created_at)
  }));

  const shared = buildSharedConversation({
    title: share.title,
    activeLeafMessageId: share.active_leaf_message_id,
    messages: tree
  });

  // A share whose recorded leaf was deleted fails closed with the same 404 as
  // an unknown token, rather than drifting onto the newest message.
  if (!shared) return jsonError("Share link not found", 404);

  return jsonOk({ share: shared });
}
