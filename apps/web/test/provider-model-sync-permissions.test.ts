import assert from "node:assert/strict";
import { test } from "node:test";
import { canSyncProviderModels } from "../src/lib/provider-model-sync";

const adminUser = { id: "admin-1", role: "admin" as const, byokEnabled: false };
const byokUser = { id: "user-1", role: "user" as const, byokEnabled: true };
const nonByokUser = { id: "user-1", role: "user" as const, byokEnabled: false };

test("provider model sync allows admins to sync global accounts", () => {
  assert.equal(canSyncProviderModels(adminUser, { scope: "global", owner_user_id: null }), true);
});

test("provider model sync blocks non-admin users from global accounts", () => {
  assert.equal(canSyncProviderModels(byokUser, { scope: "global", owner_user_id: null }), false);
});

test("provider model sync allows BYOK users to sync their own accounts", () => {
  assert.equal(canSyncProviderModels(byokUser, { scope: "user", owner_user_id: byokUser.id }), true);
});

test("provider model sync blocks user accounts without matching BYOK ownership", () => {
  assert.equal(canSyncProviderModels(nonByokUser, { scope: "user", owner_user_id: nonByokUser.id }), false);
  assert.equal(canSyncProviderModels(byokUser, { scope: "user", owner_user_id: "user-2" }), false);
});
