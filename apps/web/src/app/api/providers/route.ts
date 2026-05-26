import { authenticateRequest, encryptJsonSecret } from "@packetchat/auth";
import { providerIdSchema } from "@packetchat/contracts";
import { getSql, recordAuditEvent } from "@packetchat/db";
import { validateProviderBaseUrl } from "@packetchat/providers";
import { jsonError, jsonOk } from "../../../lib/http";
import { getUsagePricingStatus } from "../../../lib/usage";

export async function GET(request: Request) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const includeDisabledModelBindings = new URL(request.url).searchParams.get("includeDisabledModelBindings") === "true";
  const sql = getSql();
  const accounts = await sql`
    select id, provider, scope, owner_user_id, display_name, base_url, api_version, region, status, is_default, created_at, updated_at
    from provider_accounts
    where scope = 'global' or (owner_user_id = ${user.id} and ${user.byokEnabled})
    order by scope asc, display_name asc
  `;
  const accountIds = accounts.map((account) => account.id);
  const providerByAccountId = new Map(accounts.map((account) => [account.id, account.provider]));
  const modelBindings = accountIds.length
    ? await sql`
        select
          mab.id,
          mab.provider_account_id,
          coalesce(mc.vendor_model_id, mab.provider_model_ref->>'id', mab.provider_model_ref->>'model', mab.provider_model_ref->>'deployment') as model,
          coalesce(mc.display_name, mab.provider_model_ref->>'displayName', mab.provider_model_ref->>'name', mab.provider_model_ref->>'id', mab.provider_model_ref->>'model', mab.provider_model_ref->>'deployment') as display_name,
          mab.enabled,
          mab.provider_model_ref,
          mab.capability_overrides
        from model_account_bindings mab
        left join model_catalog mc on mc.id = mab.model_catalog_id
        where mab.provider_account_id = any(${accountIds})
          and (${includeDisabledModelBindings} or mab.enabled = true)
        order by mab.enabled desc, display_name asc
      `
    : [];
  return jsonOk({
    accounts,
    modelBindings: modelBindings.map((binding) => ({
      ...binding,
      usagePricing: binding.model
        ? getUsagePricingStatus(providerByAccountId.get(binding.provider_account_id), binding.model)
        : { known: false, source: "unknown" }
    })),
    byokEnabled: user.byokEnabled
  });
}

export async function POST(request: Request) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const body = await request.json().catch(() => null);
  const provider = providerIdSchema.safeParse(body?.provider);
  if (!provider.success) return jsonError("Unsupported provider", 400);
  if (!body?.apiKey) return jsonError("apiKey is required", 400);

  const scope = body.scope === "user" ? "user" : "global";
  if (scope === "global" && user.role !== "admin") return jsonError("Admin authorization required", 403);
  if (scope === "user" && !user.byokEnabled) return jsonError("BYOK is disabled for this user", 403);
  const baseUrlValidation = validateProviderBaseUrl(provider.data, body.baseUrl ? String(body.baseUrl) : null);
  if (!baseUrlValidation.ok) return jsonError(baseUrlValidation.message, 400, { code: baseUrlValidation.code });

  const sql = getSql();
  const accountRows = await sql.begin(async (tx) => {
    if (Boolean(body.isDefault)) {
      await tx`
        update provider_accounts
        set is_default = false, updated_at = now()
        where scope = ${scope}
          and (
            (${scope === "global"} and owner_user_id is null)
            or (${scope === "user"} and owner_user_id = ${user.id})
          )
      `;
    }

    const accounts = await tx<{ id: string }[]>`
      insert into provider_accounts (
        provider,
        scope,
        owner_user_id,
        display_name,
        base_url,
        api_version,
        region,
        status,
        is_default,
        created_by
      ) values (
        ${provider.data},
        ${scope},
        ${scope === "user" ? user.id : null},
        ${String(body.displayName ?? provider.data)},
        ${baseUrlValidation.value},
        ${body.apiVersion ? String(body.apiVersion) : null},
        ${body.region ? String(body.region) : null},
        'enabled',
        ${Boolean(body.isDefault)},
        ${user.id}
      )
      returning id
    `;
    await tx`
      insert into provider_credentials (provider_account_id, encrypted_payload)
      values (${accounts[0]!.id}, ${JSON.stringify(encryptJsonSecret({ apiKey: String(body.apiKey) }))}::jsonb)
    `;
    return accounts;
  });

  await recordAuditEvent({
    actorUserId: user.id,
    action: "provider.created",
    targetType: "provider_account",
    targetId: accountRows[0]!.id,
    metadata: { provider: provider.data, scope }
  });

  return jsonOk({ providerAccountId: accountRows[0]!.id });
}
