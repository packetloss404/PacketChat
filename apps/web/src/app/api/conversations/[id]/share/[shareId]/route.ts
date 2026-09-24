import { authenticateRequest } from "@packetchat/auth";
import { getConfig } from "@packetchat/config";
import { toConversationShare, type ConversationShareRow } from "@packetchat/contracts";
import { getSql } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../../../../lib/http";

type RouteContext = { params: Promise<{ id: string; shareId: string }> };

/**
 * Revokes a share link. Ownership is enforced in the same statement that writes
 * the revocation, joining the conversation's owner, so a caller can neither
 * guess a share id from another account nor observe that it exists: a missing
 * or already-revoked link is a plain 404.
 */
export async function DELETE(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { id, shareId } = await context.params;
  const sql = getSql();
  const rows = await sql<ConversationShareRow[]>`
    update conversation_shares as s
    set revoked_at = now()
    from conversations as c
    where s.id = ${shareId}
      and s.conversation_id = ${id}
      and c.id = s.conversation_id
      and c.owner_user_id = ${user.id}
      and s.revoked_at is null
    returning s.id, s.conversation_id, s.token, s.active_leaf_message_id, s.created_at, s.revoked_at
  `;
  if (!rows[0]) return jsonError("Share link not found", 404);

  return jsonOk({ share: toConversationShare(rows[0], getConfig().APP_BASE_URL) });
}
