import { getSql, recordAuditEvent } from "@packetchat/db";
import { validateProviderBaseUrl } from "@packetchat/providers";
import { requireAdminOrJson } from "../../../../../lib/admin-auth";
import { jsonError, jsonOk } from "../../../../../lib/http";

type AccountRow = {
  id: string;
  provider: "openai-compatible" | "azure-openai" | "anthropic" | "perplexity" | "minimax";
};

async function getManagedAccount(accountId: string) {
  const sql = getSql();
  const rows = await sql<AccountRow[]>`
    select id, provider
    from provider_accounts
    where id = ${accountId}
    limit 1
  `;
  return rows[0] ?? null;
}

export async function PATCH(request: Request, context: { params: Promise<{ accountId: string }> }) {
  const admin = await requireAdminOrJson(request.headers);
  if (admin instanceof Response) return admin;

  const { accountId } = await context.params;
  const account = await getManagedAccount(accountId);
  if (!account) return jsonError("Provider account not found", 404);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonError("Invalid request body", 400);
  const nextStatus = body.status === "disabled" ? "disabled" : body.status === "enabled" ? "enabled" : null;
  const nextIsDefault = body.isDefault !== undefined ? Boolean(body.isDefault) : null;
  if (nextStatus === "disabled" && nextIsDefault === true) return jsonError("Disabled provider account cannot be default", 400);
  const baseUrlValidation = body.baseUrl !== undefined
    ? validateProviderBaseUrl(account.provider, body.baseUrl ? String(body.baseUrl) : null)
    : null;
  if (baseUrlValidation && !baseUrlValidation.ok) return jsonError(baseUrlValidation.message, 400, { code: baseUrlValidation.code });

  const sql = getSql();
  const rows = await sql.begin(async (tx) => {
    if (nextIsDefault === true) {
      await tx`
        update provider_accounts
        set is_default = false, updated_at = now()
        where id <> ${accountId}
          and is_default = true
      `;
    }

    return tx`
      update provider_accounts
      set
        display_name = ${body.displayName !== undefined ? String(body.displayName) : tx`display_name`},
        base_url = ${baseUrlValidation ? baseUrlValidation.value : tx`base_url`},
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
  await recordAuditEvent({ actorUserId: admin.id, action: "provider.updated", targetType: "provider_account", targetId: accountId, metadata: { provider: account.provider } });
  return jsonOk({ providerAccountId: accountId });
}

export async function DELETE(request: Request, context: { params: Promise<{ accountId: string }> }) {
  const admin = await requireAdminOrJson(request.headers);
  if (admin instanceof Response) return admin;

  const { accountId } = await context.params;
  const account = await getManagedAccount(accountId);
  if (!account) return jsonError("Provider account not found", 404);

  const sql = getSql();
  await sql`delete from provider_accounts where id = ${accountId}`;
  await recordAuditEvent({ actorUserId: admin.id, action: "provider.deleted", targetType: "provider_account", targetId: accountId, metadata: { provider: account.provider } });
  return jsonOk({ providerAccountId: accountId });
}
