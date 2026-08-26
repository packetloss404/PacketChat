import { decryptJsonSecret } from "@packetchat/auth";
import { getSql } from "@packetchat/db";

export async function getProviderAccountForRuntime(accountId: string, options: { includeDisabled?: boolean } = {}) {
  const sql = getSql();
  const includeDisabled = options.includeDisabled === true;
  const rows = await sql<{
    id: string;
    provider: "openai-compatible" | "azure-openai" | "anthropic" | "perplexity" | "minimax";
    display_name: string;
    base_url: string | null;
    api_version: string | null;
    region: string | null;
    encrypted_payload: Record<string, string>;
  }[]>`
    select pa.*, pc.encrypted_payload
    from provider_accounts pa
    join provider_credentials pc on pc.provider_account_id = pa.id
    where pa.id = ${accountId}
      and (${includeDisabled} or pa.status = 'enabled')
    limit 1
  `;

  const account = rows[0];
  if (!account) return null;
  const secret = decryptJsonSecret<{ apiKey: string }>(account.encrypted_payload);
  return {
    provider: account.provider,
    displayName: account.display_name,
    baseUrl: account.base_url,
    apiVersion: account.api_version,
    region: account.region,
    apiKey: secret.apiKey
  };
}

export async function getEnabledModelBindingForRuntime(input: {
  accountId: string;
  provider: "openai-compatible" | "azure-openai" | "anthropic" | "perplexity" | "minimax";
  model: string;
}) {
  const sql = getSql();
  const rows = await sql<{ id: string; model: string; display_name: string }[]>`
    select
      mab.id,
      coalesce(mc.vendor_model_id, mab.provider_model_ref->>'id', mab.provider_model_ref->>'model', mab.provider_model_ref->>'deployment') as model,
      coalesce(mc.display_name, mab.provider_model_ref->>'displayName', mab.provider_model_ref->>'name', mab.provider_model_ref->>'id', mab.provider_model_ref->>'model', mab.provider_model_ref->>'deployment') as display_name
    from model_account_bindings mab
    join provider_accounts pa on pa.id = mab.provider_account_id
    left join model_catalog mc on mc.id = mab.model_catalog_id
    where pa.id = ${input.accountId}
      and pa.provider = ${input.provider}
      and pa.status = 'enabled'
      and mab.enabled = true
      and coalesce(mc.vendor_model_id, mab.provider_model_ref->>'id', mab.provider_model_ref->>'model', mab.provider_model_ref->>'deployment') = ${input.model}
    limit 1
  `;
  return rows[0] ?? null;
}
