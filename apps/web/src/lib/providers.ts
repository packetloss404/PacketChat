import { decryptJsonSecret } from "@packetchat/auth";
import { getSql } from "@packetchat/db";

export async function getProviderAccountForRuntime(accountId: string, userId: string, requireOwnership = false) {
  const sql = getSql();
  const rows = await sql<{
    id: string;
    provider: "openai-compatible" | "azure-openai" | "anthropic" | "perplexity" | "minimax";
    scope: "global" | "user";
    owner_user_id: string | null;
    display_name: string;
    base_url: string | null;
    api_version: string | null;
    region: string | null;
    encrypted_payload: Record<string, string>;
  }[]>`
    select pa.*, pc.encrypted_payload
    from provider_accounts pa
    join provider_credentials pc on pc.provider_account_id = pa.id
    left join users u on u.id = pa.owner_user_id
    where pa.id = ${accountId}
      and pa.status = 'enabled'
      and (
        pa.scope = 'global'
        or (pa.owner_user_id = ${userId} and u.byok_enabled = true)
      )
    limit 1
  `;

  const account = rows[0];
  if (!account) return null;
  if (requireOwnership && account.owner_user_id !== userId) return null;
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
