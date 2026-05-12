import { authenticateRequest, requireAdmin } from "@packetchat/auth";
import { getProviderAdapter } from "@packetchat/providers";
import { getSql, recordAuditEvent } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../../../lib/http";
import { getProviderAccountForRuntime } from "../../../../../lib/providers";
import { providerRateLimit } from "../../../../../lib/rate-limit";

export async function POST(request: Request, context: { params: Promise<{ providerId: string }> }) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);
  const rateLimited = await providerRateLimit(request, user.id);
  if (rateLimited) return rateLimited;

  const { providerId } = await context.params;
  const body = await request.json().catch(() => null);
  if (!body?.providerAccountId) return jsonError("providerAccountId is required", 400);

  const sql = getSql();
  const visibleAccounts = await sql<{ id: string; provider: string; scope: "global" | "user"; owner_user_id: string | null }[]>`
    select id, provider, scope, owner_user_id
    from provider_accounts
    where id = ${String(body.providerAccountId)}
      and status = 'enabled'
      and (
        scope = 'global'
        or (scope = 'user' and owner_user_id = ${user.id} and ${user.byokEnabled})
      )
    limit 1
  `;
  const visibleAccount = visibleAccounts[0];
  if (!visibleAccount) return jsonError("Provider account not found", 404);
  if (visibleAccount.provider !== providerId) return jsonError("Provider mismatch", 400);

  if (visibleAccount.scope === "global") {
    await requireAdmin(request.headers);
  }

  const account = await getProviderAccountForRuntime(String(body.providerAccountId), user.id, visibleAccount.scope === "user");
  if (!account) return jsonError("Provider account not found", 404);
  if (account.provider !== providerId) return jsonError("Provider mismatch", 400);

  const adapter = getProviderAdapter(account.provider);
  const result = await adapter.test(account);
  await recordAuditEvent({ actorUserId: user.id, action: "provider.tested", targetType: "provider_account", targetId: String(body.providerAccountId), metadata: { provider: account.provider, ok: result.ok } });
  return jsonOk(result, { status: result.ok ? 200 : 502 });
}
