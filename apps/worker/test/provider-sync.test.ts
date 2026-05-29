import assert from "node:assert/strict";
import { test } from "node:test";
import {
  planProviderSync,
  runProviderSync,
  type ProviderSyncDeps,
  type SyncableModel
} from "../src/provider-sync";

test("planProviderSync dedupes by id keeping first and counts duplicates", () => {
  const models: SyncableModel[] = [
    { id: "a", displayName: "First A" },
    { id: "b" },
    { id: "a", displayName: "Second A" },
    { id: "a" }
  ];
  const result = planProviderSync(models);
  assert.deepEqual(result.unique, [{ id: "a", displayName: "First A" }, { id: "b" }]);
  assert.equal(result.duplicates, 2);
});

test("planProviderSync handles empty list", () => {
  const result = planProviderSync([]);
  assert.deepEqual(result.unique, []);
  assert.equal(result.duplicates, 0);
});

test("runProviderSync persists unique models and reports ok", async () => {
  const persisted: Array<{ providerAccountId: string; models: SyncableModel[] }> = [];
  const deps: ProviderSyncDeps = {
    listModels: async () => [{ id: "x" }, { id: "y" }, { id: "x" }],
    persistModels: async (providerAccountId, models) => {
      persisted.push({ providerAccountId, models });
    }
  };

  const result = await runProviderSync("acct-1", deps);

  assert.deepEqual(result, { providerAccountId: "acct-1", modelCount: 2, ok: true });
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.providerAccountId, "acct-1");
  assert.deepEqual(persisted[0]?.models, [{ id: "x" }, { id: "y" }]);
});

test("runProviderSync returns ok:false when listModels throws and does not persist", async () => {
  let persistCalled = false;
  const deps: ProviderSyncDeps = {
    listModels: async () => {
      throw new Error("upstream unavailable");
    },
    persistModels: async () => {
      persistCalled = true;
    }
  };

  const result = await runProviderSync("acct-2", deps);

  assert.equal(result.ok, false);
  assert.equal(result.providerAccountId, "acct-2");
  assert.equal(result.modelCount, 0);
  assert.equal(result.error, "upstream unavailable");
  assert.equal(persistCalled, false);
});

test("runProviderSync returns ok:false when persistModels throws", async () => {
  const deps: ProviderSyncDeps = {
    listModels: async () => [{ id: "z" }],
    persistModels: async () => {
      throw new Error("write failed");
    }
  };

  const result = await runProviderSync("acct-3", deps);

  assert.equal(result.ok, false);
  assert.equal(result.error, "write failed");
});
