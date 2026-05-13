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
  const passwordHash = await hashPassword(String(body.password));
  const reset = await sql.begin(async (tx) => {
    const consumed = await tx<{ id: string; user_id: string }[]>`
      update password_reset_tokens
      set consumed_at = now()
      where token_hash = ${tokenHash}
        and consumed_at is null
        and expires_at > now()
      returning id, user_id
    `;

    const resetToken = consumed[0];
    if (!resetToken) return null;

    await tx`
      insert into password_credentials (user_id, password_hash, force_reset)
      values (${resetToken.user_id}, ${passwordHash}, false)
      on conflict (user_id) do update set password_hash = excluded.password_hash, force_reset = false, updated_at = now()
    `;
    await tx`update sessions set revoked_at = now(), revoked_reason = 'password reset' where user_id = ${resetToken.user_id}`;
    return resetToken;
  });

  if (!reset) return jsonError("Password reset token is invalid or expired", 404);

  await recordAuditEvent({ actorUserId: reset.user_id, action: "user.updated", targetType: "user", targetId: reset.user_id, metadata: { operation: "password_reset_completed" } });
  return jsonOk({ ok: true });
}
