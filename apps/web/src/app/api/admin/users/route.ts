import { createOpaqueToken, hashOpaqueToken, hashPassword, sendAuthEmail, validatePasswordPolicy } from "@packetchat/auth";
import { getConfig } from "@packetchat/config";
import { getSql, recordAuditEvent } from "@packetchat/db";
import { requireAdminOrJson } from "../../../../lib/admin-auth";
import { jsonError, jsonOk } from "../../../../lib/http";

export async function GET(request: Request) {
  const admin = await requireAdminOrJson(request.headers);
  if (admin instanceof Response) return admin;

  const sql = getSql();
  const users = await sql`
    select id, email, display_name, role, status, created_at, last_login_at
    from users
    order by created_at desc
  `;
  return jsonOk({ users });
}

export async function POST(request: Request) {
  const admin = await requireAdminOrJson(request.headers);
  if (admin instanceof Response) return admin;

  const body = await request.json().catch(() => null);
  if (!body?.email) return jsonError("Email is required", 400);

  const sql = getSql();
  const email = String(body.email).toLowerCase();
  const displayName = String(body.displayName ?? email);
  const role = body.role === "admin" ? "admin" : "user";

  if (body.password) {
    const passwordFailures = validatePasswordPolicy(String(body.password));
    if (passwordFailures.length > 0) return jsonError("Password does not meet policy", 400, passwordFailures);

    const passwordHash = await hashPassword(String(body.password));
    const rows = await sql.begin(async (tx) => {
      const created = await tx<{ id: string }[]>`
        insert into users (email, display_name, role, status)
        values (${email}, ${displayName}, ${role}, 'active')
        returning id
      `;
      await tx`insert into password_credentials (user_id, password_hash, force_reset) values (${created[0]!.id}, ${passwordHash}, ${Boolean(body.forceReset)})`;
      return created;
    });
    await recordAuditEvent({ actorUserId: admin.id, action: "user.created", targetType: "user", targetId: rows[0]!.id });
    return jsonOk({ userId: rows[0]!.id });
  }

  const token = createOpaqueToken(32);
  const tokenHash = hashOpaqueToken(token);
  const expiresSeconds = getConfig().INVITE_TOKEN_TTL_SECONDS;
  const created = await sql<{ id: string }[]>`
    insert into invite_tokens (email, role, token_hash, created_by, expires_at)
    values (${email}, ${role}, ${tokenHash}, ${admin.id}, now() + (${expiresSeconds} || ' seconds')::interval)
    returning id
  `;

  const config = getConfig();
  const inviteUrl = `${config.APP_BASE_URL}/login?invite=${encodeURIComponent(token)}`;
  // The invite row is already committed and inviteUrl is returned whatever the
  // mail result is, so a dead relay costs the operator a copy-paste, not the invite.
  const emailDelivery = await sendAuthEmail({ to: email, kind: "invite", url: inviteUrl, expiresSeconds });
  await recordAuditEvent({
    actorUserId: admin.id,
    action: "user.created",
    targetType: "invite",
    targetId: created[0]!.id,
    metadata: { email, emailDelivery }
  });
  return jsonOk({ inviteId: created[0]!.id, inviteUrl, emailDelivery });
}
