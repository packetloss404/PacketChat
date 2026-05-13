import { authenticateRequest } from "@packetchat/auth";
import { getSql, recordAuditEvent } from "@packetchat/db";
import { getProviderAdapter, isUnsupportedModelDiscovery, normalizeFetchError, type ProviderModelSnapshot } from "@packetchat/providers";
import { jsonError, jsonOk } from "../../../../../lib/http";
import { getProviderAccountForRuntime } from "../../../../../lib/providers";
import { providerRateLimit } from "../../../../../lib/rate-limit";

function toJsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

function providerListStatus(code: string) {
  if (code === "provider_request_timeout") return 504;
  if (code === "provider_network_error") return 503;
  return 502;
}

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
      and (
        scope = 'global'
        or (owner_user_id = ${user.id} and ${user.byokEnabled})
      )
    limit 1
  `;
  const visibleAccount = visibleAccounts[0];
  if (!visibleAccount) return jsonError("Provider account not found", 404);
  if (visibleAccount.provider !== providerId) return jsonError("Provider mismatch", 400);

  const runtimeAccount = await getProviderAccountForRuntime(String(body.providerAccountId), user.id);
  if (!runtimeAccount) return jsonError("Provider account not found", 404);

  const adapter = getProviderAdapter(runtimeAccount.provider);
  let models: ProviderModelSnapshot[];
  try {
    models = await adapter.listModels(runtimeAccount);
  } catch (error) {
    const normalized = normalizeFetchError(error, runtimeAccount.provider);
    await recordAuditEvent({
      actorUserId: user.id,
      action: "provider.models.synced",
      outcome: "failure",
      targetType: "provider_account",
      targetId: String(body.providerAccountId),
      metadata: {
        provider: runtimeAccount.provider,
        code: normalized.code,
        providerStatus: normalized.status,
        retryable: normalized.retryable
      }
    });

    if (isUnsupportedModelDiscovery(error)) {
      return jsonError("Provider model discovery is not supported for this account", 501, {
        code: "provider_model_discovery_unsupported",
        provider: runtimeAccount.provider,
        providerStatus: normalized.status,
        retryable: false
      });
    }

    return jsonError("Provider model listing failed", providerListStatus(normalized.code), {
      code: normalized.code,
      provider: runtimeAccount.provider,
      providerStatus: normalized.status,
      retryable: normalized.retryable,
      message: normalized.message
    });
  }

  await sql.begin(async (tx) => {
    const discoveredModelIds = [...new Set(models.map((model) => model.id))];
    if (discoveredModelIds.length > 0) {
      await tx`
        update model_account_bindings mab
        set enabled = false,
            updated_at = now()
        where mab.provider_account_id = ${String(body.providerAccountId)}
          and mab.enabled = true
          and coalesce(
            (select mc.vendor_model_id from model_catalog mc where mc.id = mab.model_catalog_id),
            mab.provider_model_ref->>'id',
            mab.provider_model_ref->>'model',
            mab.provider_model_ref->>'deployment'
          ) <> all(${discoveredModelIds})
      `;
    } else {
      await tx`
        update model_account_bindings
        set enabled = false,
            updated_at = now()
        where provider_account_id = ${String(body.providerAccountId)}
          and enabled = true
      `;
    }

    for (const model of models) {
      const catalogRows = await tx<{ id: string }[]>`
        insert into model_catalog (provider, vendor_model_id, display_name, raw_metadata, updated_at)
        values (${runtimeAccount.provider}, ${model.id}, ${model.displayName}, ${JSON.stringify(toJsonValue(model.raw ?? {}))}::jsonb, now())
        on conflict (provider, vendor_model_id) do update set
          display_name = excluded.display_name,
          raw_metadata = excluded.raw_metadata,
          updated_at = now()
        returning id
      `;
      const catalogId = catalogRows[0]!.id;
      const bindingRows = await tx<{ id: string }[]>`
        select id
        from model_account_bindings
        where provider_account_id = ${String(body.providerAccountId)}
          and model_catalog_id = ${catalogId}
        limit 1
      `;
      if (bindingRows[0]) {
        await tx`
          update model_account_bindings
          set provider_model_ref = ${JSON.stringify({ id: model.id, displayName: model.displayName })}::jsonb,
              enabled = true,
              updated_at = now()
          where id = ${bindingRows[0].id}
        `;
      } else {
        await tx`
          insert into model_account_bindings (provider_account_id, model_catalog_id, provider_model_ref)
          values (${String(body.providerAccountId)}, ${catalogId}, ${JSON.stringify({ id: model.id, displayName: model.displayName })}::jsonb)
        `;
      }
    }
  });

  await recordAuditEvent({ actorUserId: user.id, action: "provider.models.synced", targetType: "provider_account", targetId: String(body.providerAccountId), metadata: { provider: runtimeAccount.provider, count: models.length } });
  return jsonOk({ models });
}
