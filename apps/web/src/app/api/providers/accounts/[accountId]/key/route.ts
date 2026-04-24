import { authenticateRequest, encryptJsonSecret } from "@packetchat/auth";
import { getSql, recordAuditEvent } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../../../../lib/http";

export async function PATCH(request: Request, context: { params: Promise<{ accountId: string }> }) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { accountId } = await context.params;
  const body = await request.json().catch(() => null);
  if (!body?.apiKey) return jsonError("apiKey is required", 400);

  const sql = getSql();
  const accounts = await sql<{ id: string; provider: string; scope: "global" | "user" }[]>`
    select id, provider, scope
    from provider_accounts
    where id = ${accountId}
      and (
        (${user.role === "admin"} and scope = 'global')
        or (scope = 'user' and owner_user_id = ${user.id} and ${user.byokEnabled})
      )
    limit 1
  `;
  const account = accounts[0];
  if (!account) return jsonError("Provider account not found", 404);

  await sql`
    update provider_credentials
    set encrypted_payload = ${JSON.stringify(encryptJsonSecret({ apiKey: String(body.apiKey) }))}::jsonb,
        key_version = key_version + 1,
        updated_at = now()
    where provider_account_id = ${accountId}
  `;
  await sql`update provider_accounts set updated_at = now() where id = ${accountId}`;
  await recordAuditEvent({ actorUserId: user.id, action: "provider.key.rotated", targetType: "provider_account", targetId: accountId, metadata: { provider: account.provider, scope: account.scope } });
  return jsonOk({ providerAccountId: accountId });
}
