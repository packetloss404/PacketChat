import { authenticateRequest } from "@packetchat/auth";
import { getSql, recordAuditEvent } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../../../lib/http";

type AccountRow = {
  id: string;
  provider: string;
  scope: "global" | "user";
  owner_user_id: string | null;
};

async function getManagedAccount(accountId: string, user: { id: string; role: "admin" | "user"; byokEnabled: boolean }) {
  const sql = getSql();
  const rows = await sql<AccountRow[]>`
    select id, provider, scope, owner_user_id
    from provider_accounts
    where id = ${accountId}
      and (
        (${user.role === "admin"} and scope = 'global')
        or (scope = 'user' and owner_user_id = ${user.id} and ${user.byokEnabled})
      )
    limit 1
  `;
  return rows[0] ?? null;
}

export async function PATCH(request: Request, context: { params: Promise<{ accountId: string }> }) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { accountId } = await context.params;
  const account = await getManagedAccount(accountId, user);
  if (!account) return jsonError("Provider account not found", 404);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonError("Invalid request body", 400);
  const nextStatus = body.status === "disabled" ? "disabled" : body.status === "enabled" ? "enabled" : null;
  const nextIsDefault = body.isDefault !== undefined ? Boolean(body.isDefault) : null;
  if (nextStatus === "disabled" && nextIsDefault === true) return jsonError("Disabled provider account cannot be default", 400);

  const sql = getSql();
  const rows = await sql.begin(async (tx) => {
    if (nextIsDefault === true) {
      await tx`
        update provider_accounts
        set is_default = false, updated_at = now()
        where id <> ${accountId}
          and scope = ${account.scope}
          and (
            (${account.scope === "global"} and owner_user_id is null)
            or (${account.scope === "user"} and owner_user_id = ${account.owner_user_id})
          )
      `;
    }

    return tx`
      update provider_accounts
      set
        display_name = ${body.displayName !== undefined ? String(body.displayName) : tx`display_name`},
        base_url = ${body.baseUrl !== undefined ? (body.baseUrl ? String(body.baseUrl) : null) : tx`base_url`},
        api_version = ${body.apiVersion !== undefined ? (body.apiVersion ? String(body.apiVersion) : null) : tx`api_version`},
        region = ${body.region !== undefined ? (body.region ? String(body.region) : null) : tx`region`},
        status = ${nextStatus ?? tx`status`},
        is_default = ${nextStatus === "disabled" ? false : nextIsDefault ?? tx`is_default`},
        updated_at = now()
      where id = ${accountId}
      returning id
    `;
  });

  if (!rows[0]) return jsonError("Provider account not found", 404);
  await recordAuditEvent({ actorUserId: user.id, action: "provider.updated", targetType: "provider_account", targetId: accountId, metadata: { provider: account.provider, scope: account.scope } });
  return jsonOk({ providerAccountId: accountId });
}

export async function DELETE(request: Request, context: { params: Promise<{ accountId: string }> }) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { accountId } = await context.params;
  const account = await getManagedAccount(accountId, user);
  if (!account) return jsonError("Provider account not found", 404);

  const sql = getSql();
  await sql`delete from provider_accounts where id = ${accountId}`;
  await recordAuditEvent({ actorUserId: user.id, action: "provider.deleted", targetType: "provider_account", targetId: accountId, metadata: { provider: account.provider, scope: account.scope } });
  return jsonOk({ providerAccountId: accountId });
}
