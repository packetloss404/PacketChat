import { createOpaqueToken, hashOpaqueToken, requireAdmin, sendAuthEmail } from "@packetchat/auth";
import { getConfig } from "@packetchat/config";
import { getSql, recordAuditEvent } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../../../../lib/http";

export async function POST(request: Request, context: { params: Promise<{ userId: string }> }) {
  const admin = await requireAdmin(request.headers);
  const { userId } = await context.params;
  const config = getConfig();
  const token = createOpaqueToken(32);
  const tokenHash = hashOpaqueToken(token);
  const sql = getSql();

  const rows = await sql<{ id: string; email: string }[]>`
    select id, email
    from users
    where id = ${userId}
      and is_break_glass = false
      and status in ('active', 'locked')
    limit 1
  `;

  if (!rows[0]) return jsonError("User not found", 404);

  const resetRows = await sql<{ id: string }[]>`
    insert into password_reset_tokens (user_id, token_hash, created_by, expires_at)
    values (${userId}, ${tokenHash}, ${admin.id}, now() + (${config.PASSWORD_RESET_TOKEN_TTL_SECONDS} || ' seconds')::interval)
    returning id
  `;

  const resetUrl = `${config.APP_BASE_URL}/login?reset=${encodeURIComponent(token)}`;
  const emailDelivery = await sendAuthEmail({ to: rows[0].email, kind: "password_reset", url: resetUrl, expiresSeconds: config.PASSWORD_RESET_TOKEN_TTL_SECONDS });
  await recordAuditEvent({ actorUserId: admin.id, action: "user.updated", targetType: "user", targetId: userId, metadata: { operation: "password_reset_created", resetId: resetRows[0]!.id } });

  return jsonOk({ resetId: resetRows[0]!.id, resetUrl, emailDelivery, email: rows[0].email });
}
