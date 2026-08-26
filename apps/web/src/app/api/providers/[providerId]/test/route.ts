import { getProviderAdapter } from "@packetchat/providers";
import { recordAuditEvent } from "@packetchat/db";
import { requireAdminOrJson } from "../../../../../lib/admin-auth";
import { jsonError, jsonOk } from "../../../../../lib/http";
import { getProviderAccountForRuntime } from "../../../../../lib/providers";
import { providerRateLimit } from "../../../../../lib/rate-limit";

export async function POST(request: Request, context: { params: Promise<{ providerId: string }> }) {
  const admin = await requireAdminOrJson(request.headers);
  if (admin instanceof Response) return admin;
  const rateLimited = await providerRateLimit(request, admin.id);
  if (rateLimited) return rateLimited;

  const { providerId } = await context.params;
  const body = await request.json().catch(() => null);
  if (!body?.providerAccountId) return jsonError("providerAccountId is required", 400);

  const account = await getProviderAccountForRuntime(String(body.providerAccountId));
  if (!account) return jsonError("Provider account not found", 404);
  if (account.provider !== providerId) return jsonError("Provider mismatch", 400);

  const adapter = getProviderAdapter(account.provider);
  const result = await adapter.test(account);
  await recordAuditEvent({ actorUserId: admin.id, action: "provider.tested", targetType: "provider_account", targetId: String(body.providerAccountId), metadata: { provider: account.provider, ok: result.ok } });
  return jsonOk(result, { status: result.ok ? 200 : 502 });
}
