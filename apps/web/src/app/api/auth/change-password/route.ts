import { authenticateRequest, hashPassword, validatePasswordPolicy, verifyPassword } from "@packetchat/auth";
import { getSql, recordAuditEvent } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../../lib/http";
import { authRateLimit } from "../../../../lib/rate-limit";

export async function POST(request: Request) {
  const rateLimited = await authRateLimit(request);
  if (rateLimited) return rateLimited;

  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);
  if (user.isBreakGlass) return jsonError("Break-glass sessions cannot change passwords", 403);

  const body = await request.json().catch(() => null);
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword || !newPassword) return jsonError("Current and new passwords are required", 400);
  if (currentPassword === newPassword) return jsonError("New password must differ from current password", 400);

  const policyFailures = validatePasswordPolicy(newPassword);
  if (policyFailures.length > 0) return jsonError("Password does not meet policy", 400, policyFailures);

  const sql = getSql();
  const rows = await sql<{ password_hash: string }[]>`
    select password_hash from password_credentials where user_id = ${user.id} limit 1
  `;
  const credential = rows[0];
  if (!credential) return jsonError("No password set for this account", 404);

  const matches = await verifyPassword(credential.password_hash, currentPassword);
  if (!matches) return jsonError("Current password is incorrect", 403);

  const passwordHash = await hashPassword(newPassword);
  await sql.begin(async (tx) => {
    await tx`
      update password_credentials
      set password_hash = ${passwordHash}, force_reset = false, updated_at = now()
      where user_id = ${user.id}
    `;
    await tx`
      update sessions
      set revoked_at = now(), revoked_reason = 'password changed'
      where user_id = ${user.id} and id <> ${user.sessionId} and revoked_at is null
    `;
  });

  await recordAuditEvent({
    actorUserId: user.id,
    action: "user.updated",
    targetType: "user",
    targetId: user.id,
    metadata: { operation: "password_changed_self" }
  });

  return jsonOk({ ok: true });
}
