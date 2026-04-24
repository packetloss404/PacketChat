"use client";

import { FormEvent, useEffect, useState } from "react";
import { authFetch } from "../../lib/auth-client";
import { ConfirmButton, EmptyState, ErrorState, LoadingBlock, StatusBadge, useToast } from "../ui";

type ProviderId = "openai-compatible" | "azure-openai" | "anthropic" | "perplexity" | "minimax";
type ProviderScope = "global" | "user";

type ProviderAccount = {
  id: string;
  provider: ProviderId;
  scope: ProviderScope;
  owner_user_id: string | null;
  display_name: string;
  base_url: string | null;
  api_version: string | null;
  region: string | null;
  status: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

type ProviderModelBinding = {
  id: string;
  provider_account_id: string;
  model: string | null;
  display_name: string | null;
  enabled: boolean;
};

type ProvidersResponse = {
  accounts: ProviderAccount[];
  modelBindings: ProviderModelBinding[];
  byokEnabled: boolean;
};

const providers: { id: ProviderId; label: string; hint: string }[] = [
  { id: "openai-compatible", label: "OpenAI-compatible", hint: "Use the root host for OpenAI-compatible services. PacketChat appends /v1 routes." },
  { id: "azure-openai", label: "Azure OpenAI", hint: "Use your Azure resource endpoint; chat model names are deployment names." },
  { id: "anthropic", label: "Anthropic", hint: "Claude API provider account." },
  { id: "perplexity", label: "Perplexity", hint: "Hosted search-aware model provider." },
  { id: "minimax", label: "Minimax", hint: "Minimax model provider account." }
];

const initialForm = {
  provider: "openai-compatible" as ProviderId,
  scope: "user" as ProviderScope,
  displayName: "",
  apiKey: "",
  baseUrl: "",
  apiVersion: "",
  region: "",
  isDefault: false
};

export function ProvidersManager() {
  const toast = useToast();
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [modelBindings, setModelBindings] = useState<ProviderModelBinding[]>([]);
  const [byokEnabled, setByokEnabled] = useState<boolean | null>(null);
  const [form, setForm] = useState(initialForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ displayName: "", baseUrl: "", apiVersion: "", region: "", status: "enabled", isDefault: false });
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function apiFetch(path: string, init?: RequestInit) {
    const response = await authFetch(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init?.headers
      }
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error?.message ?? "Request failed");
    return data;
  }

  async function loadProviders() {
    setLoading(true);
    setError(null);
    try {
      const data = (await apiFetch("/api/providers")) as ProvidersResponse;
      setAccounts(data.accounts);
      setModelBindings(data.modelBindings ?? []);
      setByokEnabled(data.byokEnabled);
      if (!data.byokEnabled) setForm((current) => ({ ...current, scope: "global" }));
    } catch (err) {
      const nextError = err instanceof Error ? err.message : "Unable to load providers";
      setError(nextError);
      toast({ title: "Providers failed to load", message: nextError, variant: "error" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadProviders();
  }, []);

  async function createProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      await apiFetch("/api/providers", {
        method: "POST",
        body: JSON.stringify({
          provider: form.provider,
          scope: form.scope,
          displayName: form.displayName.trim() || providers.find((provider) => provider.id === form.provider)?.label,
          apiKey: form.apiKey,
          baseUrl: form.baseUrl.trim() || undefined,
          apiVersion: form.apiVersion.trim() || undefined,
          region: form.region.trim() || undefined,
          isDefault: form.isDefault
        })
      });
      setForm((current) => ({ ...initialForm, scope: byokEnabled === false ? "global" : current.scope }));
      setMessage("Provider account created.");
      toast({ message: "Provider account created.", variant: "success" });
      await loadProviders();
    } catch (err) {
      const nextError = err instanceof Error ? err.message : "Unable to create provider account";
      setError(nextError);
      toast({ title: "Unable to create provider", message: nextError, variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function testProvider(account: ProviderAccount) {
    setTestingId(account.id);
    setMessage(null);
    setError(null);
    try {
      const result = (await apiFetch(`/api/providers/${account.provider}/test`, {
        method: "POST",
        body: JSON.stringify({ providerAccountId: account.id })
      })) as { ok: boolean; message?: string };
      setMessage(result.message ?? (result.ok ? "Provider test succeeded." : "Provider test failed."));
      toast({ message: result.message ?? (result.ok ? "Provider test succeeded." : "Provider test failed."), variant: result.ok ? "success" : "warning" });
    } catch (err) {
      const nextError = err instanceof Error ? err.message : "Provider test failed";
      setError(nextError);
      toast({ title: "Provider test failed", message: nextError, variant: "error" });
    } finally {
      setTestingId(null);
    }
  }

  function startEdit(account: ProviderAccount) {
    setEditingId(account.id);
    setEditForm({
      displayName: account.display_name,
      baseUrl: account.base_url ?? "",
      apiVersion: account.api_version ?? "",
      region: account.region ?? "",
      status: account.status,
      isDefault: account.is_default
    });
  }

  async function updateProvider(account: ProviderAccount) {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      await apiFetch(`/api/providers/accounts/${account.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          displayName: editForm.displayName.trim() || providerLabel(account.provider),
          baseUrl: editForm.baseUrl.trim() || null,
          apiVersion: editForm.apiVersion.trim() || null,
          region: editForm.region.trim() || null,
          status: editForm.status,
          isDefault: editForm.isDefault
        })
      });
      setEditingId(null);
      setMessage("Provider account updated.");
      toast({ message: "Provider account updated.", variant: "success" });
      await loadProviders();
    } catch (err) {
      const nextError = err instanceof Error ? err.message : "Unable to update provider account";
      setError(nextError);
      toast({ title: "Unable to update provider", message: nextError, variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function rotateKey(account: ProviderAccount) {
    const apiKey = keyInputs[account.id]?.trim();
    if (!apiKey) {
      setError("Enter a new API key before rotating.");
      toast({ message: "Enter a new API key before rotating.", variant: "warning" });
      return;
    }
    setRotatingId(account.id);
    setMessage(null);
    setError(null);
    try {
      await apiFetch(`/api/providers/accounts/${account.id}/key`, {
        method: "PATCH",
        body: JSON.stringify({ apiKey })
      });
      setKeyInputs((current) => ({ ...current, [account.id]: "" }));
      setMessage("API key updated.");
      toast({ message: "API key updated.", variant: "success" });
    } catch (err) {
      const nextError = err instanceof Error ? err.message : "Unable to update API key";
      setError(nextError);
      toast({ title: "Unable to update API key", message: nextError, variant: "error" });
    } finally {
      setRotatingId(null);
    }
  }

  async function deleteProvider(account: ProviderAccount) {
    setDeletingId(account.id);
    setMessage(null);
    setError(null);
    try {
      await apiFetch(`/api/providers/accounts/${account.id}`, { method: "DELETE" });
      setMessage("Provider account deleted.");
      toast({ message: "Provider account deleted.", variant: "success" });
      await loadProviders();
    } catch (err) {
      const nextError = err instanceof Error ? err.message : "Unable to delete provider account";
      setError(nextError);
      toast({ title: "Unable to delete provider", message: nextError, variant: "error" });
    } finally {
      setDeletingId(null);
    }
  }

  async function syncModels(account: ProviderAccount) {
    setSyncingId(account.id);
    setMessage(null);
    setError(null);
    try {
      const result = (await apiFetch(`/api/providers/${account.provider}/models`, {
        method: "POST",
        body: JSON.stringify({ providerAccountId: account.id })
      })) as { models: { id: string }[] };
      setMessage(`Synced ${result.models.length} models.`);
      toast({ message: `Synced ${result.models.length} models.`, variant: "success" });
      await loadProviders();
    } catch (err) {
      const nextError = err instanceof Error ? err.message : "Unable to sync models";
      setError(nextError);
      toast({ title: "Unable to sync models", message: nextError, variant: "error" });
    } finally {
      setSyncingId(null);
    }
  }

  const selectedProvider = providers.find((provider) => provider.id === form.provider);
  const userScopeDisabled = byokEnabled === false;
  const modelsByAccount = modelBindings.reduce<Record<string, ProviderModelBinding[]>>((acc, model) => {
    acc[model.provider_account_id] = [...(acc[model.provider_account_id] ?? []), model];
    return acc;
  }, {});
  const enabledAccounts = accounts.filter((account) => account.status === "enabled").length;
  const globalAccounts = accounts.filter((account) => account.scope === "global").length;
  const userAccounts = accounts.filter((account) => account.scope === "user").length;

  return (
    <section className="providers-page">
      <div className="card providers-hero">
        <div>
          <div className="eyebrow">Providers</div>
          <h1>Manage model provider accounts</h1>
          <p className="muted">
            Add global provider keys for the instance or user-scoped BYOK accounts when enabled for your user.
          </p>
        </div>
        <button className="button" onClick={() => void loadProviders()} type="button" disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {userScopeDisabled ? (
        <div className="warning" role="status">
          User-scope BYOK is disabled for your account, so user-scoped provider accounts cannot be created. Use a global account if
          you are an admin, or ask an admin to enable BYOK.
        </div>
      ) : null}
      {message ? <div className="success-state" role="status">{message}</div> : null}
      {error ? <ErrorState title="Provider request failed" message={error} onRetry={() => void loadProviders()} /> : null}

      <div className="providers-summary-grid">
        <div className="card card--compact providers-summary-card">
          <span className="eyebrow">Enabled routes</span>
          <strong>{enabledAccounts}</strong>
          <span className="muted">usable provider accounts</span>
        </div>
        <div className="card card--compact providers-summary-card">
          <span className="eyebrow">Global</span>
          <strong>{globalAccounts}</strong>
          <span className="muted">admin-managed accounts</span>
        </div>
        <div className="card card--compact providers-summary-card">
          <span className="eyebrow">BYOK</span>
          <strong>{userAccounts}</strong>
          <span className="muted">user-scoped accounts / {byokEnabled ? "enabled" : "disabled"}</span>
        </div>
      </div>

      <div className="providers-layout">
        <form className="card providers-form" onSubmit={createProvider}>
          <h2>Add provider</h2>
          <label>
            Provider
            <select aria-label="Provider" value={form.provider} onChange={(event) => setForm({ ...form, provider: event.target.value as ProviderId })}>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.label}</option>
              ))}
            </select>
          </label>
          <p className="muted providers-hint">{selectedProvider?.hint}</p>

          <label>
            Scope
            <select aria-label="Provider account scope" value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value as ProviderScope })}>
              <option value="global">Global (admin managed)</option>
              <option value="user" disabled={userScopeDisabled}>User BYOK</option>
            </select>
          </label>

          <label>
            Display name
            <input className="input" aria-label="Provider display name" value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="Team OpenAI key" />
          </label>

          <label>
            API key
            <input className="input" aria-label="Provider API key" type="password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} placeholder="sk-..." required />
          </label>

          <div className="providers-row">
            <label>
              Base URL
              <input className="input" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder={baseUrlPlaceholder(form.provider)} />
            </label>
            <label>
              API version
              <input className="input" value={form.apiVersion} onChange={(event) => setForm({ ...form, apiVersion: event.target.value })} placeholder="2024-10-21" />
            </label>
          </div>

          <label>
            Region
            <input className="input" value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value })} placeholder="eastus" />
          </label>

          <label className="providers-checkbox">
            <input type="checkbox" checked={form.isDefault} onChange={(event) => setForm({ ...form, isDefault: event.target.checked })} />
            Set as default
          </label>

          <button className="button" disabled={saving || (form.scope === "user" && userScopeDisabled)} type="submit">
            {saving ? "Saving..." : "Save provider"}
          </button>
        </form>

        <div className="card providers-list">
          <h2>Configured accounts</h2>
          {loading ? <LoadingBlock title="Loading provider accounts" description="Checking configured accounts and synced models." /> : null}
          {!loading && accounts.length === 0 ? <EmptyState title="No provider accounts" description="Add a provider account with a valid key to enable chat, agents, and model sync." /> : null}
          {accounts.map((account) => (
            <article className={`providers-account ${account.status !== "enabled" ? "providers-account--disabled" : ""}`} key={account.id}>
              {editingId === account.id ? (
                <div className="providers-form">
                  <label>
                    Display name
                    <input className="input" value={editForm.displayName} onChange={(event) => setEditForm({ ...editForm, displayName: event.target.value })} />
                  </label>
                  <div className="providers-row">
                    <label>
                      Base URL
                      <input className="input" value={editForm.baseUrl} onChange={(event) => setEditForm({ ...editForm, baseUrl: event.target.value })} />
                    </label>
                    <label>
                      API version
                      <input className="input" value={editForm.apiVersion} onChange={(event) => setEditForm({ ...editForm, apiVersion: event.target.value })} />
                    </label>
                  </div>
                  <div className="providers-row">
                    <label>
                      Region
                      <input className="input" value={editForm.region} onChange={(event) => setEditForm({ ...editForm, region: event.target.value })} />
                    </label>
                    <label>
                      Status
                      <select value={editForm.status} onChange={(event) => setEditForm({ ...editForm, status: event.target.value })}>
                        <option value="enabled">Enabled</option>
                        <option value="disabled">Disabled</option>
                      </select>
                    </label>
                  </div>
                  <label className="providers-checkbox">
                    <input type="checkbox" checked={editForm.isDefault} onChange={(event) => setEditForm({ ...editForm, isDefault: event.target.checked })} />
                    Set as default
                  </label>
                </div>
              ) : (
                <div>
                  <h3>{account.display_name}</h3>
                  <div className="providers-badge-row">
                    <StatusBadge tone="info">{providerLabel(account.provider)}</StatusBadge>
                    <StatusBadge tone={account.scope === "user" ? "warning" : "success"}>{account.scope === "user" ? "Your BYOK" : "Global"}</StatusBadge>
                    <StatusBadge>{account.status}</StatusBadge>
                  </div>
                  <p className="muted providers-meta">
                    {[account.base_url, account.api_version, account.region].filter(Boolean).join(" / ") || "No endpoint metadata"}
                  </p>
                  <div className="providers-model-strip" aria-label={`Synced models for ${account.display_name}`}>
                    {(modelsByAccount[account.id] ?? []).length ? (
                      <>
                        <span className="providers-pill">{(modelsByAccount[account.id] ?? []).length} models</span>
                        {(modelsByAccount[account.id] ?? []).slice(0, 4).map((model) => (
                          <span className="providers-model-chip" key={model.id}>{model.display_name ?? model.model}</span>
                        ))}
                        {(modelsByAccount[account.id] ?? []).length > 4 ? <span className="muted">+{(modelsByAccount[account.id] ?? []).length - 4} more</span> : null}
                      </>
                    ) : (
                      <span className="muted">No models discovered yet. Use manual model entry in chat or sync models.</span>
                    )}
                  </div>
                  <div className="providers-row">
                    <input className="input" aria-label={`New API key for ${account.display_name}`} type="password" value={keyInputs[account.id] ?? ""} onChange={(event) => setKeyInputs({ ...keyInputs, [account.id]: event.target.value })} placeholder="New API key" />
                    <button className="button" onClick={() => void rotateKey(account)} disabled={rotatingId === account.id} type="button">
                      {rotatingId === account.id ? "Updating..." : "Update key"}
                    </button>
                  </div>
                </div>
              )}
              <div className="providers-actions">
                {account.is_default ? <span className="providers-pill">Default</span> : null}
                {editingId === account.id ? (
                  <>
                    <button className="button" onClick={() => void updateProvider(account)} disabled={saving} type="button">
                      {saving ? "Saving..." : "Save"}
                    </button>
                    <button className="button" onClick={() => setEditingId(null)} disabled={saving} type="button">Cancel</button>
                  </>
                ) : (
                  <button className="button" onClick={() => startEdit(account)} type="button">Edit</button>
                )}
                <button className="button" onClick={() => void testProvider(account)} disabled={testingId === account.id} type="button">
                  {testingId === account.id ? "Testing..." : "Test connection"}
                </button>
                <button className="button" onClick={() => void syncModels(account)} disabled={syncingId === account.id} type="button">
                  {syncingId === account.id ? "Syncing..." : "Sync models"}
                </button>
                <ConfirmButton message={`Delete ${account.display_name}?`} confirmLabel="Delete" disabled={deletingId === account.id} onConfirm={() => deleteProvider(account)}>
                  {deletingId === account.id ? "Deleting..." : "Delete"}
                </ConfirmButton>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function providerLabel(providerId: ProviderId) {
  return providers.find((provider) => provider.id === providerId)?.label ?? providerId;
}

function baseUrlPlaceholder(providerId: ProviderId) {
  if (providerId === "azure-openai") return "https://your-resource.openai.azure.com";
  if (providerId === "anthropic") return "https://api.anthropic.com";
  if (providerId === "perplexity") return "https://api.perplexity.ai";
  if (providerId === "minimax") return "https://api.minimax.io";
  return "https://api.openai.com or compatible root host";
}
