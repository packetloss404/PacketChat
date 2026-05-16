export type ProviderModelSyncUser = {
  id: string;
  role: "admin" | "user";
  byokEnabled: boolean;
};

export type ProviderModelSyncAccount = {
  scope: "global" | "user";
  owner_user_id: string | null;
};

export function canSyncProviderModels(user: ProviderModelSyncUser, account: ProviderModelSyncAccount) {
  if (account.scope === "global") return user.role === "admin";
  return account.owner_user_id === user.id && user.byokEnabled;
}
