import { getConfig } from "@packetchat/config";
import { getSql, recordAuditEvent } from "@packetchat/db";
import { hashPassword, validatePasswordPolicy } from "@packetchat/auth";
import { jsonError, jsonOk } from "../../../../lib/http";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const config = getConfig();
  if (!body || body.bootstrapToken !== config.BOOTSTRAP_TOKEN) return jsonError("Invalid bootstrap token", 403);
  if (!body.email || !body.password) return jsonError("Email and password are required", 400);

  const passwordFailures = validatePasswordPolicy(String(body.password));
  if (passwordFailures.length > 0) return jsonError("Password does not meet policy", 400, passwordFailures);

  const sql = getSql();
  const passwordHash = await hashPassword(String(body.password));
  const rows = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('packetchat.bootstrap'))`;

    const existing = await tx<{ count: string }[]>`select count(*)::text as count from users`;
    if (existing[0]?.count !== "0") return null;

    const created = await tx<{ id: string }[]>`
      insert into users (email, display_name, role, status)
      values (${String(body.email).toLowerCase()}, ${String(body.displayName ?? "Admin")}, 'admin', 'active')
      returning id
    `;
    await tx`insert into password_credentials (user_id, password_hash) values (${created[0]!.id}, ${passwordHash})`;

    return created;
  });

  if (!rows) return jsonError("Bootstrap is already complete", 409);

  await recordAuditEvent({ actorUserId: rows[0]!.id, action: "bootstrap.completed", targetType: "user", targetId: rows[0]!.id });
  return jsonOk({ ok: true, adminUserId: rows[0]!.id });
}
