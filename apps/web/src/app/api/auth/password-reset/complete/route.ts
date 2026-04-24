import { hashOpaqueToken, hashPassword, validatePasswordPolicy } from "@packetchat/auth";
import { getSql, recordAuditEvent } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../../../lib/http";
import { authRateLimit } from "../../../../../lib/rate-limit";

export async function POST(request: Request) {
  const rateLimited = await authRateLimit(request);
  if (rateLimited) return rateLimited;

  const body = await request.json().catch(() => null);
  if (!body?.token || !body?.password) return jsonError("Token and password are required", 400);
  const passwordFailures = validatePasswordPolicy(String(body.password));
  if (passwordFailures.length > 0) return jsonError("Password does not meet policy", 400, passwordFailures);

  const tokenHash = hashOpaqueToken(String(body.token));
  const sql = getSql();
  const rows = await sql<{ id: string; user_id: string }[]>`
    select id, user_id
    from password_reset_tokens
    where token_hash = ${tokenHash}
      and consumed_at is null
      and expires_at > now()
    limit 1
  `;

  const reset = rows[0];
  if (!reset) return jsonError("Password reset token is invalid or expired", 404);

  const passwordHash = await hashPassword(String(body.password));
  await sql.begin(async (tx) => {
    await tx`
      insert into password_credentials (user_id, password_hash, force_reset)
      values (${reset.user_id}, ${passwordHash}, false)
      on conflict (user_id) do update set password_hash = excluded.password_hash, force_reset = false, updated_at = now()
    `;
    await tx`update password_reset_tokens set consumed_at = now() where id = ${reset.id}`;
    await tx`update sessions set revoked_at = now(), revoked_reason = 'password reset' where user_id = ${reset.user_id}`;
  });

  await recordAuditEvent({ actorUserId: reset.user_id, action: "user.updated", targetType: "user", targetId: reset.user_id, metadata: { operation: "password_reset_completed" } });
  return jsonOk({ ok: true });
}
