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

  const sql = getSql();
  const tokenHash = hashOpaqueToken(String(body.token));
  const passwordHash = await hashPassword(String(body.password));
  const userRows = await sql.begin(async (tx) => {
    const invites = await tx<{
      id: string;
      email: string;
      role: "admin" | "user";
    }[]>`
      select id, email, role
      from invite_tokens
      where token_hash = ${tokenHash}
        and consumed_at is null
        and expires_at > now()
      limit 1
      for update
    `;

    const invite = invites[0];
    if (!invite) return null;

    const displayName = String(body.displayName ?? invite.email);
    const users = await tx<{ id: string }[]>`
      insert into users (email, display_name, role, status)
      values (${invite.email}, ${displayName}, ${invite.role}, 'active')
      returning id
    `;
    await tx`insert into password_credentials (user_id, password_hash) values (${users[0]!.id}, ${passwordHash})`;
    const consumed = await tx<{ id: string }[]>`
      update invite_tokens
      set consumed_by = ${users[0]!.id}, consumed_at = now()
      where id = ${invite.id}
        and consumed_at is null
      returning id
    `;
    if (!consumed[0]) throw new Error("Invite token consumption failed");
    return users;
  });

  if (!userRows) return jsonError("Invite token is invalid or expired", 404);

  await recordAuditEvent({ actorUserId: userRows[0]!.id, action: "user.created", targetType: "user", targetId: userRows[0]!.id, metadata: { via: "invite" } });
  return jsonOk({ userId: userRows[0]!.id });
}
