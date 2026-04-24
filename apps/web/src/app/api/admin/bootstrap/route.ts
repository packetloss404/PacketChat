import { getConfig } from "@packetchat/config";
import { getSql, recordAuditEvent } from "@packetchat/db";
import { hashPassword } from "@packetchat/auth";
import { jsonError, jsonOk } from "../../../../lib/http";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const config = getConfig();
  if (!body || body.bootstrapToken !== config.BOOTSTRAP_TOKEN) return jsonError("Invalid bootstrap token", 403);
  if (!body.email || !body.password) return jsonError("Email and password are required", 400);

  const sql = getSql();
  const existing = await sql<{ count: string }[]>`select count(*)::text as count from users`;
  if (existing[0]?.count !== "0") return jsonError("Bootstrap is already complete", 409);

  const passwordHash = await hashPassword(String(body.password));
  const breakGlassPasswordHash = body.breakGlassEmail && body.breakGlassPassword ? await hashPassword(String(body.breakGlassPassword)) : null;
  const rows = await sql.begin(async (tx) => {
    const created = await tx<{ id: string }[]>`
      insert into users (email, display_name, role, status)
      values (${String(body.email).toLowerCase()}, ${String(body.displayName ?? "Admin")}, 'admin', 'active')
      returning id
    `;
    await tx`insert into password_credentials (user_id, password_hash) values (${created[0]!.id}, ${passwordHash})`;

    if (breakGlassPasswordHash) {
      const breakGlassRows = await tx<{ id: string }[]>`
        insert into users (email, display_name, role, status, is_break_glass)
        values (${String(body.breakGlassEmail).toLowerCase()}, ${String(body.breakGlassDisplayName ?? "Break Glass Admin")}, 'admin', 'active', true)
        returning id
      `;
      await tx`insert into password_credentials (user_id, password_hash) values (${breakGlassRows[0]!.id}, ${breakGlassPasswordHash})`;
    }

    return created;
  });

  await recordAuditEvent({ actorUserId: rows[0]!.id, action: "bootstrap.completed", targetType: "user", targetId: rows[0]!.id });
  return jsonOk({ ok: true, adminUserId: rows[0]!.id });
}
