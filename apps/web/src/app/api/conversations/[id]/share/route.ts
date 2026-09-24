import { authenticateRequest } from "@packetchat/auth";
import { getConfig } from "@packetchat/config";
import { generateShareToken, toConversationShare, type ConversationShareRow } from "@packetchat/contracts";
import { getSql } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../../../lib/http";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { id } = await context.params;
  const sql = getSql();
  const owned = await sql<{ id: string }[]>`
    select id from conversations where id = ${id} and owner_user_id = ${user.id} limit 1
  `;
  if (!owned[0]) return jsonError("Conversation not found", 404);

  const rows = await sql<ConversationShareRow[]>`
    select id, conversation_id, token, active_leaf_message_id, created_at, revoked_at
    from conversation_shares
    where conversation_id = ${id}
    order by created_at desc
  `;

  const baseUrl = getConfig().APP_BASE_URL;
  return jsonOk({ shares: rows.map((row) => toConversationShare(row, baseUrl)) });
}

export async function POST(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { id } = await context.params;
  const sql = getSql();
  const owned = await sql<{ active_leaf_message_id: string | null }[]>`
    select active_leaf_message_id
    from conversations
    where id = ${id} and owner_user_id = ${user.id}
    limit 1
  `;
  if (!owned[0]) return jsonError("Conversation not found", 404);

  const baseUrl = getConfig().APP_BASE_URL;
  const token = generateShareToken();

  // The partial unique index on (conversation_id) where revoked_at is null makes
  // creating a second live link a no-op, so a double-click or two tabs converge
  // on one share instead of minting a link one of them cannot see.
  const inserted = await sql<ConversationShareRow[]>`
    insert into conversation_shares (conversation_id, owner_user_id, token, active_leaf_message_id)
    values (${id}, ${user.id}, ${token}, ${owned[0].active_leaf_message_id})
    on conflict (conversation_id) where revoked_at is null do nothing
    returning id, conversation_id, token, active_leaf_message_id, created_at, revoked_at
  `;
  if (inserted[0]) return jsonOk({ share: toConversationShare(inserted[0], baseUrl) }, { status: 201 });

  const existing = await sql<ConversationShareRow[]>`
    select id, conversation_id, token, active_leaf_message_id, created_at, revoked_at
    from conversation_shares
    where conversation_id = ${id} and revoked_at is null
    limit 1
  `;
  if (!existing[0]) return jsonError("Unable to create share link", 409);

  return jsonOk({ share: toConversationShare(existing[0], baseUrl) });
}
