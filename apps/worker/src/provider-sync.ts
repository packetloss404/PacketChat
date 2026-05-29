export type SyncableModel = { id: string; displayName?: string };

export function planProviderSync(models: SyncableModel[]): {
  unique: SyncableModel[];
  duplicates: number;
} {
  const seen = new Set<string>();
  const unique: SyncableModel[] = [];
  let duplicates = 0;
  for (const model of models) {
    if (seen.has(model.id)) {
      duplicates += 1;
      continue;
    }
    seen.add(model.id);
    unique.push(model);
  }
  return { unique, duplicates };
}

export type ProviderSyncDeps = {
  listModels: (providerAccountId: string) => Promise<SyncableModel[]>;
  persistModels: (providerAccountId: string, models: SyncableModel[]) => Promise<void>;
};

export type ProviderSyncResult = {
  providerAccountId: string;
  modelCount: number;
  ok: boolean;
  error?: string;
};

export async function runProviderSync(
  providerAccountId: string,
  deps: ProviderSyncDeps
): Promise<ProviderSyncResult> {
  try {
    const models = await deps.listModels(providerAccountId);
    const { unique } = planProviderSync(models);
    await deps.persistModels(providerAccountId, unique);
    return { providerAccountId, modelCount: unique.length, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { providerAccountId, modelCount: 0, ok: false, error: message };
  }
}
