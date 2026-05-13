import { getSql } from "@packetchat/db";

type AuthUser = {
  id: string;
  role?: string;
};

export type AgentAccessRole = "viewer" | "runner" | "editor" | "owner";

export type AgentAccess = {
  agentId: string;
  ownerUserId: string;
  accessRole: AgentAccessRole;
  canView: boolean;
  canRun: boolean;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
};

function roleRank(role: AgentAccessRole) {
  switch (role) {
    case "owner":
      return 4;
    case "editor":
      return 3;
    case "runner":
      return 2;
    case "viewer":
      return 1;
  }
}

function normalizeRole(value: unknown): AgentAccessRole | null {
  return value === "viewer" || value === "runner" || value === "editor" || value === "owner" ? value : null;
}

export function isAgentAccessRole(value: unknown): value is AgentAccessRole {
  return normalizeRole(value) !== null;
}

export async function getAgentAccess(agentId: string, user: AuthUser): Promise<AgentAccess | null> {
  const sql = getSql();
  const rows = await sql<{ id: string; owner_user_id: string; permission_role: AgentAccessRole | null }[]>`
    select a.id, a.owner_user_id, ap.role as permission_role
    from agents a
    left join agent_permissions ap on ap.agent_id = a.id and ap.subject_user_id = ${user.id}
    where a.id = ${agentId}
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;

  const ownAgent = row.owner_user_id === user.id || user.role === "admin";
  const accessRole = ownAgent ? "owner" : row.permission_role;
  if (!accessRole) return null;

  const rank = roleRank(accessRole);
  return {
    agentId: row.id,
    ownerUserId: row.owner_user_id,
    accessRole,
    canView: true,
    canRun: rank >= roleRank("viewer"),
    canEdit: rank >= roleRank("editor"),
    canShare: rank >= roleRank("owner"),
    canDelete: ownAgent || accessRole === "owner"
  };
}
