import { decryptJsonSecret } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { getProviderAdapter, isUnsupportedModelDiscovery, type ProviderAccountRuntime, type ProviderModelSnapshot } from "@packetchat/providers";
import { logger } from "@packetchat/observability";
import type { ProviderSyncDeps, SyncableModel } from "./provider-sync";

type ProviderId = ProviderAccountRuntime["provider"];

export type ExistingBinding = {
  id: string;
  vendorModelId: string | null;
};

export type BindingPlan = {
  inserts: SyncableModel[];
  updates: { bindingId: string; model: SyncableModel }[];
  stale: string[];
};

/**
 * Ports the adapter needs from the outside world. The defaults talk to postgres
 * and the real provider adapters; tests inject fakes.
 */
export type ProviderSyncPorts = {
  loadAccount: (providerAccountId: string) => Promise<ProviderAccountRuntime | null>;
  discoverModels: (account: ProviderAccountRuntime) => Promise<ProviderModelSnapshot[]>;
  upsertBindings: (providerAccountId: string, models: SyncableModel[]) => Promise<void>;
};

export function toSyncableModels(snapshots: ProviderModelSnapshot[]): SyncableModel[] {
  const models: SyncableModel[] = [];
  for (const snapshot of snapshots) {
    const id = typeof snapshot.id === "string" ? snapshot.id.trim() : "";
    if (!id) continue;
    const displayName = typeof snapshot.displayName === "string" ? snapshot.displayName.trim() : "";
    models.push(displayName ? { id, displayName } : { id });
  }
  return models;
}

/**
 * Model identity is the vendor model id: model_catalog.vendor_model_id when the
 * binding is linked to a catalog row, otherwise the id/model/deployment key on
 * provider_model_ref. That is the same expression the chat runtime resolves a
 * binding by, so matching on it keeps sync and routing in agreement.
 */
export function planBindingWrites(existing: ExistingBinding[], models: SyncableModel[]): BindingPlan {
  const byVendorModelId = new Map<string, ExistingBinding>();
  for (const binding of existing) {
    if (!binding.vendorModelId) continue;
    if (!byVendorModelId.has(binding.vendorModelId)) byVendorModelId.set(binding.vendorModelId, binding);
  }

  const inserts: SyncableModel[] = [];
  const updates: { bindingId: string; model: SyncableModel }[] = [];
  const reported = new Set<string>();

  for (const model of models) {
    const id = model.id.trim();
    if (!id || reported.has(id)) continue;
    reported.add(id);
    const normalized: SyncableModel = model.displayName ? { id, displayName: model.displayName } : { id };
    const match = byVendorModelId.get(id);
    if (match) updates.push({ bindingId: match.id, model: normalized });
    else inserts.push(normalized);
  }

  // Bindings the provider no longer reports. We only report them; the writer
  // leaves the rows alone. A background sync sees one listing call and cannot
  // tell a retired model from a partial or degraded provider response, and
  // silently disabling a binding would break every conversation pinned to it.
  // Retiring a model stays an explicit admin action (the providers models
  // route), which does disable what is missing.
  const stale = existing.filter((binding) => !binding.vendorModelId || !reported.has(binding.vendorModelId)).map((binding) => binding.id);

  return { inserts, updates, stale };
}

async function loadAccountFromDatabase(providerAccountId: string): Promise<ProviderAccountRuntime | null> {
  const sql = getSql();
  const rows = await sql<{
    provider: ProviderId;
    display_name: string;
    base_url: string | null;
    api_version: string | null;
    region: string | null;
    encrypted_payload: Record<string, string>;
  }[]>`
    select pa.provider, pa.display_name, pa.base_url, pa.api_version, pa.region, pc.encrypted_payload
    from provider_accounts pa
    join provider_credentials pc on pc.provider_account_id = pa.id
    where pa.id = ${providerAccountId}
      and pa.status = 'enabled'
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

async function upsertBindingsInDatabase(providerAccountId: string, models: SyncableModel[]): Promise<void> {
  // Nothing reported means nothing to write: stale bindings are left as they are.
  if (models.length === 0) return;

  const sql = getSql();
  await sql.begin(async (tx) => {
    // Serialise concurrent syncs for the same account. The bindings upsert is a
    // read-then-insert and model_account_bindings has no unique constraint on
    // (provider_account_id, model_catalog_id), so two jobs that both read before
    // either commits would both insert and double every binding. Two producers
    // now enqueue these and WORKER_CONCURRENCY defaults to 2, so the overlap is
    // reachable. Same pattern as the bootstrap route.
    await tx`select pg_advisory_xact_lock(hashtext(${`packetchat.provider-sync:${providerAccountId}`}))`;

    const accountRows = await tx<{ provider: ProviderId }[]>`
      select provider
      from provider_accounts
      where id = ${providerAccountId}
      limit 1
    `;
    const provider = accountRows[0]?.provider;
    if (!provider) throw new Error("Provider account not found");

    const existingRows = await tx<{ id: string; vendor_model_id: string | null }[]>`
      select
        mab.id,
        coalesce(
          mc.vendor_model_id,
          mab.provider_model_ref->>'id',
          mab.provider_model_ref->>'model',
          mab.provider_model_ref->>'deployment'
        ) as vendor_model_id
      from model_account_bindings mab
      left join model_catalog mc on mc.id = mab.model_catalog_id
      where mab.provider_account_id = ${providerAccountId}
    `;

    const plan = planBindingWrites(
      existingRows.map((row) => ({ id: row.id, vendorModelId: row.vendor_model_id })),
      models
    );

    const upsertCatalogModel = async (model: SyncableModel) => {
      // raw_metadata is left untouched on conflict: SyncableModel carries no raw
      // provider payload, so writing here would erase what the admin-triggered
      // sync stored.
      const catalogRows = await tx<{ id: string }[]>`
        insert into model_catalog (provider, vendor_model_id, display_name, updated_at)
        values (${provider}, ${model.id}, ${model.displayName ?? model.id}, now())
        on conflict (provider, vendor_model_id) do update set
          display_name = excluded.display_name,
          updated_at = now()
        returning id
      `;
      return catalogRows[0]!.id;
    };

    for (const update of plan.updates) {
      const catalogId = await upsertCatalogModel(update.model);
      // enabled and capability_overrides are deliberately absent: an operator's
      // choices survive a resync.
      await tx`
        update model_account_bindings
        set model_catalog_id = ${catalogId},
            provider_model_ref = ${JSON.stringify({ id: update.model.id, displayName: update.model.displayName ?? update.model.id })}::jsonb,
            updated_at = now()
        where id = ${update.bindingId}
      `;
    }

    for (const insert of plan.inserts) {
      const catalogId = await upsertCatalogModel(insert);
      // The advisory lock above already serialises the sane paths; the conflict
      // clause is the backstop that makes a duplicate impossible even if some
      // future writer skips the lock. Refresh the model ref rather than doing
      // nothing, so a racing insert still lands the newer display name, and
      // leave enabled/capability_overrides alone so operator choices survive.
      await tx`
        insert into model_account_bindings (provider_account_id, model_catalog_id, provider_model_ref, enabled)
        values (${providerAccountId}, ${catalogId}, ${JSON.stringify({ id: insert.id, displayName: insert.displayName ?? insert.id })}::jsonb, true)
        on conflict (provider_account_id, model_catalog_id) where model_catalog_id is not null
        do update set provider_model_ref = excluded.provider_model_ref, updated_at = now()
      `;
    }

    logger.info("Provider sync bindings written", {
      providerAccountId,
      inserted: plan.inserts.length,
      updated: plan.updates.length,
      stale: plan.stale.length
    });
  });
}

const databasePorts: ProviderSyncPorts = {
  loadAccount: loadAccountFromDatabase,
  discoverModels: (account) => getProviderAdapter(account.provider).listModels(account),
  upsertBindings: upsertBindingsInDatabase
};

export function createProviderSyncDeps(ports: ProviderSyncPorts = databasePorts): ProviderSyncDeps {
  return {
    async listModels(providerAccountId) {
      const account = await ports.loadAccount(providerAccountId);
      if (!account) throw new Error("Provider account not found or disabled");

      try {
        return toSyncableModels(await ports.discoverModels(account));
      } catch (error) {
        // Endpoints without a model listing route are a supported configuration,
        // not a sync failure.
        if (isUnsupportedModelDiscovery(error)) {
          logger.info("Provider model discovery unsupported", { providerAccountId, provider: account.provider });
          return [];
        }
        throw error;
      }
    },
    async persistModels(providerAccountId, models) {
      await ports.upsertBindings(providerAccountId, models);
    }
  };
}
