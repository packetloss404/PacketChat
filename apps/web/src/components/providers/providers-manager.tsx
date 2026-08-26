"use client";

import { FormEvent, useEffect, useState } from "react";
import { authFetch } from "../../lib/auth-client";
import { ConfirmButton, EmptyState, ErrorState, LoadingBlock, StatusBadge, useToast } from "../ui";

type ProviderId = "openai-compatible" | "azure-openai" | "anthropic" | "perplexity" | "minimax";

type ProviderAccount = {
  id: string;
  provider: ProviderId;
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
  enabled?: boolean;
  provider_model_ref?: Record<string, unknown> | null;
  capability_overrides?: Record<string, unknown> | null;
  usagePricing?: Record<string, unknown> | null;
};

type ProvidersResponse = {
  accounts: ProviderAccount[];
  modelBindings: ProviderModelBinding[];
};

const providers: { id: ProviderId; label: string; hint: string }[] = [
  { id: "openai-compatible", label: "OpenAI-compatible", hint: "Base host for OpenAI-compatible services." },
  { id: "azure-openai", label: "Azure OpenAI", hint: "Use your Azure resource endpoint; chat model names are deployment names." },
  { id: "anthropic", label: "Anthropic", hint: "Claude API provider account." },
  { id: "perplexity", label: "Perplexity", hint: "Hosted search-aware model provider." },
  { id: "minimax", label: "MiniMax", hint: "MiniMax model provider account." }
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isRuntimeEnabledStatus(status: string) {
  const normalized = status.toLowerCase();
  return normalized === "enabled" || normalized === "active" || normalized === "ok";
}

function isBindingEnabled(binding: ProviderModelBinding) {
  return binding.enabled ?? true;
}

function modelLabel(binding: ProviderModelBinding) {
  return binding.display_name ?? binding.model ?? "Unnamed model";
}

function pickNumber(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    const next = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(next)) return next;
  }
  return null;
}

function pricingRates(binding: ProviderModelBinding) {
  const usagePricing = asRecord(binding.usagePricing);
  const rates = asRecord(usagePricing?.rates);
  const source = rates ?? usagePricing ?? asRecord(binding.capability_overrides) ?? {};
  return {
    input: pickNumber(source, ["input", "inputPerMillion", "prompt"]),
    output: pickNumber(source, ["output", "outputPerMillion", "completion"]),
    cacheRead: pickNumber(source, ["cacheRead", "cache_read"]),
    cacheWrite: pickNumber(source, ["cacheWrite", "cache_write"]),
    search: pickNumber(source, ["searchPerQuery", "search_per_query"])
  };
}

function hasKnownPricing(binding: ProviderModelBinding) {
  const usagePricing = asRecord(binding.usagePricing);
  if (typeof usagePricing?.known === "boolean") return usagePricing.known;
  return Object.values(pricingRates(binding)).some((value) => value !== null);
}

function formatPricingSummary(binding: ProviderModelBinding) {
  const rates = pricingRates(binding);
  const parts = [
    rates.input !== null ? `in $${rates.input}` : null,
    rates.output !== null ? `out $${rates.output}` : null,
    rates.search !== null ? `search $${rates.search}` : null
  ].filter(Boolean);
  return parts.length ? parts.join(" / ") : null;
}

function truthyCapability(source: Record<string, unknown>, keys: string[]) {
  return keys.some((key) => source[key] === true || source[key] === "true");
}

function readContextLength(binding: ProviderModelBinding) {
  const source = asRecord(binding.capability_overrides) ?? {};
  return pickNumber(source, ["contextLength", "context_length", "context"]);
}

function formatContextLength(value: number | null) {
  if (value === null || value <= 0) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M context`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K context`;
  return `${value} context`;
}

function capabilitySummary(binding: ProviderModelBinding) {
  const source = asRecord(binding.capability_overrides);
  if (!source || Object.keys(source).length === 0) return [];
  const labels = [
    formatContextLength(readContextLength(binding)),
    truthyCapability(source, ["vision", "supportsVision", "imageInput", "image_input"]) ? "Vision" : null,
    truthyCapability(source, ["tools", "toolUse", "tool_use", "functionCalling", "function_calling"]) ? "Tools" : null,
    truthyCapability(source, ["streaming"]) ? "Streaming" : null,
    truthyCapability(source, ["jsonMode", "json_mode", "structuredOutputs", "structured_outputs"]) ? "Structured output" : null,
    truthyCapability(source, ["thinking", "reasoning"]) ? "Reasoning" : null
  ].filter((label): label is string => Boolean(label));
  if (labels.length > 0) return labels.slice(0, 3);
  return Object.keys(source).slice(0, 3);
}

const initialForm = {
  provider: "openai-compatible" as ProviderId,
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
      const data = (await apiFetch("/api/providers?includeDisabledModelBindings=true")) as ProvidersResponse;
      setAccounts(data.accounts);
      setModelBindings(data.modelBindings ?? []);
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
          displayName: form.displayName.trim() || providers.find((provider) => provider.id === form.provider)?.label,
          apiKey: form.apiKey,
          baseUrl: form.baseUrl.trim() || undefined,
          apiVersion: form.apiVersion.trim() || undefined,
          region: form.region.trim() || undefined,
          isDefault: form.isDefault
        })
      });
      setForm(initialForm);
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
  const modelsByAccount = modelBindings.reduce<Record<string, ProviderModelBinding[]>>((acc, model) => {
    acc[model.provider_account_id] = [...(acc[model.provider_account_id] ?? []), model];
    return acc;
  }, {});
  const enabledAccounts = accounts.filter((account) => isRuntimeEnabledStatus(account.status)).length;
  const disabledAccounts = accounts.length - enabledAccounts;
  const enabledModelBindings = modelBindings.filter(isBindingEnabled).length;
  const disabledModelBindings = modelBindings.length - enabledModelBindings;
  const pricedModelBindings = modelBindings.filter(hasKnownPricing).length;
  const unpricedModelBindings = modelBindings.filter((binding) => binding.model && !hasKnownPricing(binding)).length;
  const capabilityModels = modelBindings.filter((binding) => capabilitySummary(binding).length > 0).length;
  const defaultAccount = accounts.find((account) => isRuntimeEnabledStatus(account.status) && account.is_default) ?? accounts.find((account) => account.is_default);
  const defaultModel = defaultAccount ? (modelsByAccount[defaultAccount.id] ?? []).find(isBindingEnabled) : null;

  return (
    <section className="providers-page">
      <div className="card providers-hero">
        <div>
          <div className="eyebrow">Providers</div>
          <h1>Provider accounts</h1>
          <p className="muted">
            Provider keys are app-wide. Every account added here is available to all users.
          </p>
        </div>
        <button className="button" onClick={() => void loadProviders()} type="button" disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {accounts.length > 0 && enabledAccounts === 0 ? (
        <div className="warning" role="status">
          All provider accounts are disabled. Chat and agents won't work until at least one account is enabled.
        </div>
      ) : null}
      {enabledAccounts > 0 && !accounts.some((account) => isRuntimeEnabledStatus(account.status) && account.is_default) ? (
        <div className="providers-notice" role="status">
          No default account set. Chat and agents will use the first enabled account.
        </div>
      ) : null}
      {unpricedModelBindings > 0 ? (
        <div className="providers-notice" role="status">
          {unpricedModelBindings} synced {unpricedModelBindings === 1 ? "model has" : "models have"} unknown pricing and will be reported as unknown cost in usage views.
        </div>
      ) : null}
      {message ? <div className="success-state" role="status">{message}</div> : null}
      {error ? <ErrorState title="Provider request failed" message={error} onRetry={() => void loadProviders()} /> : null}

      <div className="providers-summary-grid">
        <div className="card card--compact providers-summary-card">
          <span className="eyebrow">Enabled accounts</span>
          <strong>{enabledAccounts}</strong>
          <span className="muted">{disabledAccounts} disabled provider {disabledAccounts === 1 ? "account" : "accounts"}</span>
        </div>
        <div className="card card--compact providers-summary-card">
          <span className="eyebrow">Default account</span>
          <strong className="providers-summary-route">{defaultAccount ? defaultAccount.display_name : "Unset"}</strong>
          <span className="muted">{defaultModel ? modelLabel(defaultModel) : defaultAccount ? "No enabled bound model" : "No default account"}</span>
        </div>
        <div className="card card--compact providers-summary-card">
          <span className="eyebrow">Models</span>
          <strong>{enabledModelBindings}/{modelBindings.length}</strong>
          <span className="muted">enabled bindings{disabledModelBindings ? `, ${disabledModelBindings} disabled` : ""}</span>
        </div>
        <div className="card card--compact providers-summary-card">
          <span className="eyebrow">Cost data</span>
          <strong>{pricedModelBindings}/{modelBindings.length}</strong>
          <span className="muted">priced models, {capabilityModels} with capability data</span>
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

          <p className="muted providers-hint">
            This key applies to the whole app. Disabled accounts aren't used in chat or agents.
          </p>

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

          <button className="button" disabled={saving} type="submit">
            {saving ? "Saving..." : "Save provider"}
          </button>
        </form>

        <div className="card providers-list">
          <h2>Configured accounts</h2>
          {loading ? <LoadingBlock title="Loading provider accounts" description="Checking configured accounts and synced models." /> : null}
          {!loading && accounts.length === 0 ? <EmptyState title="No provider accounts" description="Add a provider account with a valid key to enable chat, agents, and model sync." /> : null}
          {accounts.map((account) => {
            const accountEnabled = isRuntimeEnabledStatus(account.status);
            const accountModels = modelsByAccount[account.id] ?? [];
            const accountEnabledModels = accountModels.filter(isBindingEnabled).length;
            const accountPricedModels = accountModels.filter(hasKnownPricing).length;
            const accountCapabilities = [...new Set(accountModels.flatMap(capabilitySummary))].slice(0, 4);
            const routeMetadata = [account.base_url, account.api_version, account.region].filter(Boolean).join(" / ");
            return (
            <article className={`providers-account ${accountEnabled ? "" : "providers-account--disabled"}`} key={account.id}>
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
                      <select
                        value={editForm.status}
                        onChange={(event) => {
                          const status = event.target.value;
                          setEditForm({ ...editForm, status, isDefault: status === "disabled" ? false : editForm.isDefault });
                        }}
                      >
                        <option value="enabled">Enabled</option>
                        <option value="disabled">Disabled</option>
                      </select>
                    </label>
                  </div>
                  <label className="providers-checkbox">
                    <input type="checkbox" checked={editForm.isDefault} disabled={editForm.status === "disabled"} onChange={(event) => setEditForm({ ...editForm, isDefault: event.target.checked })} />
                    Set as default
                  </label>
                </div>
              ) : (
                <div>
                  <h3>{account.display_name}</h3>
                  <div className="providers-badge-row">
                    <StatusBadge tone="info">{providerLabel(account.provider)}</StatusBadge>
                    <StatusBadge tone="success">App-wide</StatusBadge>
                    <StatusBadge tone={accountEnabled ? "success" : "neutral"}>{accountEnabled ? "Enabled" : "Disabled"}</StatusBadge>
                  </div>
                  <p className="muted providers-meta">
                    {routeMetadata || "No endpoint metadata"}
                  </p>
                  <div className="providers-governance-row" aria-label={`Governance summary for ${account.display_name}`}>
                    <span className="providers-pill">{accountEnabledModels}/{accountModels.length} models enabled</span>
                    <span className={`providers-pill ${accountModels.length > 0 && accountPricedModels < accountModels.length ? "providers-pill--warning" : ""}`}>
                      {accountPricedModels}/{accountModels.length} priced
                    </span>
                    {accountCapabilities.map((capability) => (
                      <span className="providers-pill" key={capability}>{capability}</span>
                    ))}
                    {account.is_default ? <span className="providers-pill providers-pill--success">Default</span> : null}
                  </div>
                  {!accountEnabled ? (
                    <div className="providers-inline-warning" role="status">
                      Disabled accounts aren't used in chat, agents, or sync until re-enabled.
                    </div>
                  ) : null}
                  <div className="providers-model-strip" aria-label={`Synced models for ${account.display_name}`}>
                    {accountModels.length ? (
                      <>
                        <span className="providers-pill">{accountModels.length} models</span>
                        {accountModels.slice(0, 5).map((model) => {
                          const modelEnabled = isBindingEnabled(model);
                          const modelMeta = [
                            modelEnabled ? "Enabled" : "Disabled",
                            formatPricingSummary(model),
                            ...capabilitySummary(model)
                          ].filter(Boolean).join(" / ");
                          return (
                            <span className={`providers-model-chip ${modelEnabled ? "" : "providers-model-chip--disabled"}`} key={model.id} title={modelMeta}>
                              {modelLabel(model)}{modelEnabled ? "" : " (disabled)"}
                            </span>
                          );
                        })}
                        {accountModels.length > 5 ? <span className="muted">+{accountModels.length - 5} more</span> : null}
                      </>
                    ) : (
                      <span className="muted">No models discovered yet. Use manual model entry in chat or sync models.</span>
                    )}
                  </div>
                  <div className="providers-row">
                    <input className="input" aria-label={`New API key for ${account.display_name}`} type="password" value={keyInputs[account.id] ?? ""} onChange={(event) => setKeyInputs({ ...keyInputs, [account.id]: event.target.value })} placeholder="New API key" />
                    <button className="button" onClick={() => void rotateKey(account)} disabled={rotatingId === account.id} type="button">
                      {rotatingId === account.id ? "Updating..." : "Replace key"}
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
                <button className="button" onClick={() => void testProvider(account)} disabled={!accountEnabled || testingId === account.id} title={accountEnabled ? undefined : "Enable this account before testing"} type="button">
                  {testingId === account.id ? "Testing..." : "Test connection"}
                </button>
                <button className="button" onClick={() => void syncModels(account)} disabled={!accountEnabled || syncingId === account.id} title={accountEnabled ? undefined : "Enable this account before syncing models"} type="button">
                  {syncingId === account.id ? "Syncing..." : "Sync models"}
                </button>
                <ConfirmButton message={`Delete ${account.display_name}?`} confirmLabel="Delete" disabled={deletingId === account.id} onConfirm={() => deleteProvider(account)}>
                  {deletingId === account.id ? "Deleting..." : "Delete"}
                </ConfirmButton>
              </div>
            </article>
            );
          })}
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
