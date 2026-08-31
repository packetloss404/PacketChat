import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderAccountRuntime, ProviderModelSnapshot } from "@packetchat/providers";
import { ProviderFetchError } from "../../../packages/providers/src/provider-http";
import { runProviderSync, type SyncableModel } from "../src/provider-sync";
import {
  createProviderSyncDeps,
  planBindingWrites,
  toSyncableModels,
  type ExistingBinding,
  type ProviderSyncPorts
} from "../src/provider-sync-deps";

function account(provider: ProviderAccountRuntime["provider"] = "openai-compatible"): ProviderAccountRuntime {
  return {
    provider,
    displayName: "Test account",
    baseUrl: null,
    apiVersion: null,
    region: null,
    apiKey: "test-key"
  };
}

function ports(overrides: Partial<ProviderSyncPorts> = {}): ProviderSyncPorts {
  return {
    loadAccount: async () => account(),
    discoverModels: async () => [],
    upsertBindings: async () => undefined,
    ...overrides
  };
}

test("toSyncableModels trims ids, drops blank ids and drops empty display names", () => {
  const snapshots: ProviderModelSnapshot[] = [
    { id: " gpt-4o ", displayName: " GPT-4o " },
    { id: "gpt-4o-mini", displayName: "   " },
    { id: "   ", displayName: "ignored" }
  ];
  assert.deepEqual(toSyncableModels(snapshots), [
    { id: "gpt-4o", displayName: "GPT-4o" },
    { id: "gpt-4o-mini" }
  ]);
});

test("planBindingWrites updates known models, inserts new ones and reports stale bindings", () => {
  const existing: ExistingBinding[] = [
    { id: "binding-1", vendorModelId: "gpt-4o" },
    { id: "binding-2", vendorModelId: "retired-model" }
  ];
  const models: SyncableModel[] = [{ id: "gpt-4o", displayName: "GPT-4o" }, { id: "gpt-4o-mini" }];

  const plan = planBindingWrites(existing, models);

  assert.deepEqual(plan.updates, [{ bindingId: "binding-1", model: { id: "gpt-4o", displayName: "GPT-4o" } }]);
  assert.deepEqual(plan.inserts, [{ id: "gpt-4o-mini" }]);
  assert.deepEqual(plan.stale, ["binding-2"]);
});

test("planBindingWrites dedupes reported models and keeps the first display name", () => {
  const plan = planBindingWrites([], [
    { id: "claude-sonnet", displayName: "First" },
    { id: "claude-sonnet", displayName: "Second" },
    { id: " claude-sonnet " }
  ]);

  assert.deepEqual(plan.inserts, [{ id: "claude-sonnet", displayName: "First" }]);
  assert.equal(plan.updates.length, 0);
});

test("planBindingWrites treats an unresolvable binding as stale and never matches it", () => {
  const plan = planBindingWrites([{ id: "binding-1", vendorModelId: null }], [{ id: "gpt-4o" }]);

  assert.deepEqual(plan.inserts, [{ id: "gpt-4o" }]);
  assert.deepEqual(plan.stale, ["binding-1"]);
});

test("planBindingWrites matches only the first binding when two share a vendor model id", () => {
  const plan = planBindingWrites(
    [{ id: "binding-1", vendorModelId: "gpt-4o" }, { id: "binding-2", vendorModelId: "gpt-4o" }],
    [{ id: "gpt-4o" }]
  );

  assert.deepEqual(plan.updates, [{ bindingId: "binding-1", model: { id: "gpt-4o" } }]);
  assert.deepEqual(plan.inserts, []);
  assert.deepEqual(plan.stale, []);
});

test("listModels discovers models for the loaded account", async () => {
  const loaded: string[] = [];
  const deps = createProviderSyncDeps(ports({
    loadAccount: async (providerAccountId) => {
      loaded.push(providerAccountId);
      return account("anthropic");
    },
    discoverModels: async (runtime) => {
      assert.equal(runtime.provider, "anthropic");
      return [{ id: "claude-sonnet", displayName: "Claude Sonnet" }];
    }
  }));

  assert.deepEqual(await deps.listModels("acct-1"), [{ id: "claude-sonnet", displayName: "Claude Sonnet" }]);
  assert.deepEqual(loaded, ["acct-1"]);
});

test("listModels throws for a missing or disabled account without calling the provider", async () => {
  let discoverCalled = false;
  const deps = createProviderSyncDeps(ports({
    loadAccount: async () => null,
    discoverModels: async () => {
      discoverCalled = true;
      return [];
    }
  }));

  await assert.rejects(deps.listModels("acct-missing"), /Provider account not found or disabled/);
  assert.equal(discoverCalled, false);
});

test("listModels returns an empty list when the provider has no discovery endpoint", async () => {
  const deps = createProviderSyncDeps(ports({
    discoverModels: async () => {
      throw new ProviderFetchError({ code: "provider_request_failed", message: "not found", retryable: false, status: 404 });
    }
  }));

  assert.deepEqual(await deps.listModels("acct-1"), []);
});

test("listModels rethrows real provider failures", async () => {
  const deps = createProviderSyncDeps(ports({
    discoverModels: async () => {
      throw new ProviderFetchError({ code: "provider_request_failed", message: "upstream is down", retryable: true, status: 503 });
    }
  }));

  await assert.rejects(deps.listModels("acct-1"), /upstream is down/);
});

test("persistModels forwards the account id and models to the writer", async () => {
  const written: { providerAccountId: string; models: SyncableModel[] }[] = [];
  const deps = createProviderSyncDeps(ports({
    upsertBindings: async (providerAccountId, models) => {
      written.push({ providerAccountId, models });
    }
  }));

  await deps.persistModels("acct-1", [{ id: "gpt-4o" }]);

  assert.deepEqual(written, [{ providerAccountId: "acct-1", models: [{ id: "gpt-4o" }] }]);
});

test("runProviderSync drives the adapter end to end with fake ports", async () => {
  const written: SyncableModel[][] = [];
  const deps = createProviderSyncDeps(ports({
    discoverModels: async () => [{ id: "gpt-4o", displayName: "GPT-4o" }, { id: "gpt-4o", displayName: "GPT-4o" }],
    upsertBindings: async (_providerAccountId, models) => {
      written.push(models);
    }
  }));

  const result = await runProviderSync("acct-1", deps);

  assert.deepEqual(result, { providerAccountId: "acct-1", modelCount: 1, ok: true });
  assert.deepEqual(written, [[{ id: "gpt-4o", displayName: "GPT-4o" }]]);
});
