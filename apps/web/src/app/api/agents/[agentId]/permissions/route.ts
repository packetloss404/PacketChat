import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { getAgentAccess, isAgentAccessRole, type AgentAccessRole } from "../../../../../lib/agent-access";
import { jsonError, jsonOk } from "../../../../../lib/http";

type RouteContext = { params: Promise<{ agentId: string }> };

type PermissionUpdate = {
  userId?: unknown;
  role?: unknown;
};

function normalizeUpdates(value: unknown): Array<{ userId: string; role: AgentAccessRole | null }> | null {
  if (!Array.isArray(value)) return null;
  const updates = [];
  for (const item of value as PermissionUpdate[]) {
    if (!item || typeof item !== "object" || typeof item.userId !== "string") return null;
    if (item.role === null || item.role === "none") {
      updates.push({ userId: item.userId, role: null });
      continue;
    }
    if (!isAgentAccessRole(item.role)) return null;
    updates.push({ userId: item.userId, role: item.role });
  }
  return updates;
}

export async function GET(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { agentId } = await context.params;
  const access = await getAgentAccess(agentId, user);
  if (!access?.canShare) return jsonError("Agent not found", 404);

  const sql = getSql();
  const permissions = await sql`
    select ap.id, ap.subject_user_id, ap.role, ap.created_at, u.email, u.display_name
    from agent_permissions ap
    join users u on u.id = ap.subject_user_id
    where ap.agent_id = ${agentId}
    order by u.email asc
  `;
  const users = await sql`
    select id, email, display_name, role, status
    from users
    where status = 'active' and id <> ${access.ownerUserId}
    order by email asc
  `;

  return jsonOk({ access, permissions, users });
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { agentId } = await context.params;
  const access = await getAgentAccess(agentId, user);
  if (!access?.canShare) return jsonError("Agent not found", 404);

  const body = await request.json().catch(() => null);
  const updates = normalizeUpdates(body?.permissions);
  if (!updates) return jsonError("permissions must be an array of { userId, role }", 400);

  const sql = getSql();
  await sql.begin(async (tx) => {
    for (const update of updates) {
      if (update.userId === access.ownerUserId) continue;
      if (!update.role) {
        await tx`delete from agent_permissions where agent_id = ${agentId} and subject_user_id = ${update.userId}`;
        continue;
      }
      await tx`
        insert into agent_permissions (agent_id, subject_user_id, role)
        values (${agentId}, ${update.userId}, ${update.role})
        on conflict (agent_id, subject_user_id)
        do update set role = excluded.role
      `;
    }
  });

  const permissions = await sql`
    select ap.id, ap.subject_user_id, ap.role, ap.created_at, u.email, u.display_name
    from agent_permissions ap
    join users u on u.id = ap.subject_user_id
    where ap.agent_id = ${agentId}
    order by u.email asc
  `;
  return jsonOk({ permissions });
}
