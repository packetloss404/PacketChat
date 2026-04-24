import { requireAdmin } from "@packetchat/auth";
import { getSql, recordAuditEvent } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../../../../lib/http";

export async function PATCH(request: Request, context: { params: Promise<{ userId: string }> }) {
  const admin = await requireAdmin(request.headers);
  const { userId } = await context.params;
  const body = await request.json().catch(() => null);
  if (typeof body?.byokEnabled !== "boolean") return jsonError("byokEnabled boolean is required", 400);

  const sql = getSql();
  const rows = await sql<{ id: string; byok_enabled: boolean }[]>`
    update users
    set byok_enabled = ${body.byokEnabled}, updated_at = now()
    where id = ${userId} and is_break_glass = false
    returning id, byok_enabled
  `;

  if (!rows[0]) return jsonError("User not found", 404);
  await recordAuditEvent({ actorUserId: admin.id, action: "user.byok.updated", targetType: "user", targetId: userId, metadata: { byokEnabled: body.byokEnabled } });
  return jsonOk({ userId, byokEnabled: rows[0].byok_enabled });
}
