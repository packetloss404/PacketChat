import { getSql, recordAuditEvent } from "@packetchat/db";
import { requireAdminOrJson } from "../../../../../../../lib/admin-auth";
import { jsonError, jsonOk } from "../../../../../../../lib/http";

type BindingRow = {
  id: string;
  provider_account_id: string;
  provider: string;
  model: string | null;
};

async function getManagedBinding(accountId: string, bindingId: string) {
  const sql = getSql();
  const rows = await sql<BindingRow[]>`
    select
      mab.id,
      mab.provider_account_id,
      pa.provider,
      coalesce(
        mc.vendor_model_id,
        mab.provider_model_ref->>'id',
        mab.provider_model_ref->>'model',
        mab.provider_model_ref->>'deployment'
      ) as model
    from model_account_bindings mab
    join provider_accounts pa on pa.id = mab.provider_account_id
    left join model_catalog mc on mc.id = mab.model_catalog_id
    where mab.id = ${bindingId}
      and mab.provider_account_id = ${accountId}
    limit 1
  `;
  return rows[0] ?? null;
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ accountId: string; bindingId: string }> }
) {
  const admin = await requireAdminOrJson(request.headers);
  if (admin instanceof Response) return admin;

  const { accountId, bindingId } = await context.params;
  const binding = await getManagedBinding(accountId, bindingId);
  if (!binding) return jsonError("Model binding not found", 404);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || typeof body.enabled !== "boolean") {
    return jsonError("enabled (boolean) is required", 400);
  }

  const sql = getSql();
  const rows = await sql<{ enabled: boolean }[]>`
    update model_account_bindings
    set enabled = ${body.enabled},
        updated_at = now()
    where id = ${bindingId}
      and provider_account_id = ${accountId}
    returning enabled
  `;
  const updated = rows[0];
  if (!updated) return jsonError("Model binding not found", 404);

  await recordAuditEvent({
    actorUserId: admin.id,
    action: "provider.binding.updated",
    targetType: "model_account_binding",
    targetId: bindingId,
    metadata: {
      provider: binding.provider,
      providerAccountId: accountId,
      model: binding.model,
      enabled: updated.enabled
    }
  });

  return jsonOk({ providerAccountId: accountId, bindingId, enabled: updated.enabled });
}
