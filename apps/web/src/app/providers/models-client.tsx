"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { ProvidersManager } from "../../components/providers/providers-manager";
import { apiClient, type ProviderAccount, type ProviderModelBinding } from "../../lib/api-client";
import { LoadingBlock, StatusBadge, useToast } from "../../components/ui";
import { Icon } from "../../components/icons";

type ModelTab = "models" | "settings";
type DetailTab = "overview" | "parameters";

type ModelRow = ProviderModelBinding & {
  account: ProviderAccount;
};

type CustomModel = {
  id: string;
  provider: string;
  displayName: string;
  modelId: string;
  contextLength: number | null;
  notes: string;
  createdAt: string;
};

type ProviderMeta = {
  id: string;
  name: string;
  tint: string;
  glyph: string;
};

const PROVIDERS: Record<string, ProviderMeta> = {
  "openai-compatible": { id: "openai-compatible", name: "OpenAI", tint: "#10a37f", glyph: "O" },
  anthropic: { id: "anthropic", name: "Anthropic", tint: "#d97757", glyph: "A" },
  "azure-openai": { id: "azure-openai", name: "Azure OpenAI", tint: "#4b8ad6", glyph: "Az" },
  perplexity: { id: "perplexity", name: "Perplexity", tint: "#1fb8cd", glyph: "P" },
  minimax: { id: "minimax", name: "MiniMax", tint: "#7c3aed", glyph: "M" },
  google: { id: "google", name: "Google", tint: "#4285f4", glyph: "G" }
};

const CUSTOM_MODELS_KEY = "packetchat.models.custom";

function providerMeta(id: string): ProviderMeta {
  return PROVIDERS[id] ?? { id, name: id, tint: "#5f5f63", glyph: (id[0] ?? "?").toUpperCase() };
}

function formatContext(binding: ProviderModelBinding): string | null {
  const overrides = (binding.capability_overrides ?? null) as Record<string, unknown> | null;
  const raw = overrides?.contextLength ?? overrides?.context_length ?? overrides?.context ?? null;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readPricing(binding: ProviderModelBinding) {
  const usagePricing = asRecord(binding.usagePricing);
  const rates = asRecord(usagePricing?.rates);
  const source = rates ?? usagePricing ?? asRecord(binding.capability_overrides) ?? {};
  const pick = (key: string) => {
    const value = source?.[key];
    const next = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(next) ? next : null;
  };
  return {
    input: pick("input") ?? pick("inputPerMillion") ?? pick("prompt"),
    output: pick("output") ?? pick("outputPerMillion") ?? pick("completion"),
    cacheRead: pick("cacheRead") ?? pick("cache_read"),
    cacheWrite: pick("cacheWrite") ?? pick("cache_write"),
    search: pick("searchPerQuery") ?? pick("search_per_query")
  };
}

function hasPricing(binding: ProviderModelBinding) {
  const usagePricing = asRecord(binding.usagePricing);
  if (typeof usagePricing?.known === "boolean") return usagePricing.known;
  return Object.values(readPricing(binding)).some((value) => value !== null && Number.isFinite(value));
}

function formatPrice(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null;
  return Number.isInteger(value) ? String(value) : String(value);
}

function priceSummary(binding: ProviderModelBinding) {
  const pricing = readPricing(binding);
  const parts = [
    pricing.input !== null ? `in $${formatPrice(pricing.input)}` : null,
    pricing.output !== null ? `out $${formatPrice(pricing.output)}` : null,
    pricing.search !== null ? `search $${formatPrice(pricing.search)}` : null
  ].filter(Boolean);
  return parts.length ? parts.join(" / ") : null;
}

function isRuntimeEnabledStatus(status: string) {
  const normalized = status.toLowerCase();
  return normalized === "enabled" || normalized === "active" || normalized === "ok";
}

const FEATURE_CATALOG = [
  { id: "plugins", label: "Plugins", providerAllowed: ["anthropic", "openai-compatible", "azure-openai"] },
  { id: "vision", label: "Vision", providerAllowed: ["anthropic", "openai-compatible", "azure-openai", "google"] },
  { id: "cache", label: "Prompt caching", providerAllowed: ["anthropic"] },
  { id: "system", label: "System role", providerAllowed: ["anthropic", "openai-compatible", "azure-openai"] },
  { id: "streaming", label: "Streaming", providerAllowed: ["anthropic", "openai-compatible", "azure-openai", "perplexity", "minimax", "google"] },
  { id: "thinking", label: "Thinking mode", providerAllowed: ["anthropic"] },
  { id: "background", label: "Background mode", providerAllowed: [] }
];

const PROVIDER_TOOLS: Record<string, Array<{ id: string; label: string }>> = {
  anthropic: [
    { id: "web", label: "Web Browser" },
    { id: "sandbox", label: "Code Sandbox" }
  ],
  "openai-compatible": [{ id: "web", label: "Web Browser" }],
  "azure-openai": [{ id: "web", label: "Web Browser" }],
  perplexity: [{ id: "web", label: "Web Browser" }],
  google: [{ id: "web", label: "Web Browser" }],
  minimax: []
};

const PARAM_LABELS: Array<{ keys: string[]; label: string; format?: (value: unknown) => string }> = [
  { keys: ["temperature"], label: "Temperature" },
  { keys: ["maxOutputTokens", "max_output_tokens", "maxTokens", "max_tokens"], label: "Max output tokens" },
  { keys: ["topP", "top_p"], label: "Top P" },
  { keys: ["topK", "top_k"], label: "Top K" },
  {
    keys: ["stopSequences", "stop_sequences", "stop"],
    label: "Stop sequences",
    format: (value) => Array.isArray(value) ? value.map((v) => String(v)).join(", ") : String(value)
  }
];

function readCustomModels(): CustomModel[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_MODELS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is CustomModel => entry && typeof entry === "object" && typeof entry.id === "string");
  } catch {
    return [];
  }
}

function writeCustomModels(list: CustomModel[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CUSTOM_MODELS_KEY, JSON.stringify(list));
  } catch {
    /* swallow quota errors */
  }
}

function ProviderBadge({ id, size = 22 }: { id: string; size?: number }) {
  const meta = providerMeta(id);
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: size,
        display: "inline-grid",
        placeItems: "center",
        background: meta.tint,
        color: "#fff",
        fontSize: Math.max(9, Math.floor(size * 0.46)),
        fontWeight: 700,
        flexShrink: 0
      }}
    >
      {meta.glyph}
    </span>
  );
}

export function ModelsClient() {
  const [tab, setTab] = useState<ModelTab>("models");
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [bindings, setBindings] = useState<ProviderModelBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [selectedBindingId, setSelectedBindingId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");
  const [moreOpen, setMoreOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [customModels, setCustomModels] = useState<CustomModel[]>([]);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const data = await apiClient.providers.list({ includeDisabledModelBindings: true });
        if (cancelled) return;
        setAccounts(data.accounts ?? []);
        setBindings(data.modelBindings ?? []);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setCustomModels(readCustomModels());
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    function handleClick(event: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMoreOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [moreOpen]);

  const accountById = useMemo(() => {
    const map = new Map<string, ProviderAccount>();
    accounts.forEach((account) => map.set(account.id, account));
    return map;
  }, [accounts]);

  const isAccountEnabled = useMemo(() => {
    return (accountId: string) => {
      const account = accountById.get(accountId);
      if (!account) return false;
      return isRuntimeEnabledStatus(account.status);
    };
  }, [accountById]);

  const rows = useMemo<ModelRow[]>(() => {
    return bindings
      .map((binding) => {
        const account = accountById.get(binding.provider_account_id);
        return account ? { ...binding, account } : null;
      })
      .filter((row): row is ModelRow => row !== null);
  }, [bindings, accountById]);

  const providerIds = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((row) => set.add(row.account.provider));
    return [...set].sort((a, b) => providerMeta(a).name.localeCompare(providerMeta(b).name));
  }, [rows]);

  const providerStats = useMemo(() => {
    const result: Record<string, { enabled: number; total: number }> = {};
    rows.forEach((row) => {
      const id = row.account.provider;
      const entry = result[id] ?? { enabled: 0, total: 0 };
      entry.total += 1;
      const accountEnabled = isAccountEnabled(row.account.id);
      const effective = accountEnabled && (row.enabled ?? true);
      if (effective) entry.enabled += 1;
      result[id] = entry;
    });
    return result;
  }, [rows, isAccountEnabled]);

  const totals = useMemo(() => {
    let enabled = 0;
    rows.forEach((row) => {
      const accountEnabled = isAccountEnabled(row.account.id);
      if (accountEnabled && (row.enabled ?? true)) enabled += 1;
    });
    return { enabled, total: rows.length };
  }, [rows, isAccountEnabled]);

  const customRowsForCategory = useMemo(() => {
    if (categoryId === "all") return customModels;
    if (categoryId === "others") return customModels.filter((entry) => !PROVIDERS[entry.provider]);
    return customModels.filter((entry) => entry.provider === categoryId);
  }, [customModels, categoryId]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (categoryId !== "all" && categoryId !== "others" && row.account.provider !== categoryId) return false;
      if (categoryId === "others" && PROVIDERS[row.account.provider]) return false;
      if (!needle) return true;
      const hay = [row.model ?? "", row.display_name ?? "", row.account.display_name ?? "", row.account.provider]
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [rows, categoryId, query]);

  const filteredCustom = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return customRowsForCategory;
    return customRowsForCategory.filter((entry) => {
      const hay = [entry.displayName, entry.modelId, entry.provider, entry.notes].join(" ").toLowerCase();
      return hay.includes(needle);
    });
  }, [customRowsForCategory, query]);

  useEffect(() => {
    if (filtered.length > 0) {
      const present = filtered.some((row) => row.id === selectedBindingId);
      if (!present) {
        setSelectedBindingId(filtered[0].id);
      }
    } else if (selectedBindingId !== null) {
      setSelectedBindingId(null);
    }
  }, [filtered, selectedBindingId]);

  const selected = useMemo(() => rows.find((row) => row.id === selectedBindingId) ?? null, [rows, selectedBindingId]);

  function handleExport() {
    setMoreOpen(false);
    const payload = {
      exportedAt: new Date().toISOString(),
      bindings: rows.map((row) => ({
        bindingId: row.id,
        accountId: row.account.id,
        provider: row.account.provider,
        accountName: row.account.display_name,
        model: row.model,
        displayName: row.display_name,
        accountEnabled: isAccountEnabled(row.account.id),
        bindingEnabled: row.enabled ?? true
      })),
      customModels
    };
    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `packetchat-models-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      toast({ message: "Exported model list.", variant: "success" });
    } catch (err) {
      toast({
        title: "Export failed",
        message: err instanceof Error ? err.message : String(err),
        variant: "error"
      });
    }
  }

  function handleAddCustomModel(entry: CustomModel) {
    const next = [...customModels, entry];
    setCustomModels(next);
    writeCustomModels(next);
    setAddOpen(false);
    toast({
      message: "Custom model registration is not yet wired to a backend endpoint. Saved locally for reference.",
      variant: "info"
    });
  }

  function handleRemoveCustomModel(id: string) {
    const next = customModels.filter((entry) => entry.id !== id);
    setCustomModels(next);
    writeCustomModels(next);
  }

  if (tab === "settings") {
    return (
      <section className="models-lib">
        <ModelsHeader tab={tab} onTabChange={setTab} onAdd={() => setAddOpen(true)} />
        <div className="sheet__inner" style={{ paddingTop: 12 }}>
          <ProvidersManager />
        </div>
        {addOpen ? <AddCustomModelDialog onClose={() => setAddOpen(false)} onSubmit={handleAddCustomModel} /> : null}
      </section>
    );
  }

  return (
    <section className="models-lib">
      <ModelsHeader tab={tab} onTabChange={setTab} onAdd={() => setAddOpen(true)} />

      {error ? <p className="error-state" role="alert" style={{ marginTop: 12 }}>{error}</p> : null}
      {loading ? <LoadingBlock title="Loading models" /> : null}

      {!loading ? (
        <div className="models-lib__layout">
          <aside className="models-lib__rail" aria-label="Model categories">
            <button
              type="button"
              className={`models-rail-item ${categoryId === "all" ? "on" : ""}`}
              onClick={() => setCategoryId("all")}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  background: "var(--bg-3)",
                  display: "grid",
                  placeItems: "center",
                  color: "var(--ink-2)"
                }}
              >
                <Icon.grid />
              </span>
              <span className="models-rail-item__body">
                <strong>All models</strong>
                <span>{totals.enabled} / {totals.total} enabled</span>
              </span>
            </button>

            {providerIds.map((providerId) => {
              const meta = providerMeta(providerId);
              const stats = providerStats[providerId] ?? { enabled: 0, total: 0 };
              return (
                <button
                  key={providerId}
                  type="button"
                  className={`models-rail-item ${categoryId === providerId ? "on" : ""}`}
                  onClick={() => setCategoryId(providerId)}
                >
                  <ProviderBadge id={providerId} size={28} />
                  <span className="models-rail-item__body">
                    <strong>{meta.name}</strong>
                    <span>{stats.enabled} / {stats.total} enabled</span>
                  </span>
                  <span className={`models-rail-item__dot ${stats.enabled > 0 ? "on" : ""}`} aria-hidden="true" />
                  <span className="models-rail-item__cog" aria-hidden="true"><Icon.params /></span>
                </button>
              );
            })}

            <button
              type="button"
              className={`models-rail-item ${categoryId === "others" ? "on" : ""}`}
              onClick={() => setCategoryId("others")}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  background: "var(--bg-3)",
                  display: "grid",
                  placeItems: "center",
                  color: "var(--ink-2)"
                }}
              >
                <Icon.mcp />
              </span>
              <span className="models-rail-item__body">
                <strong>Others</strong>
                <span>{customModels.filter((entry) => !PROVIDERS[entry.provider]).length} custom</span>
              </span>
            </button>
          </aside>

          <section className="models-lib__list" aria-label="Models">
            <div className="models-lib__search">
              <label className="prompt-lib__search" style={{ flex: 1 }}>
                <Icon.search />
                <input
                  placeholder="Search..."
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label="Search models"
                />
              </label>
              <div ref={moreRef} style={{ position: "relative" }}>
                <button
                  className="ib"
                  type="button"
                  aria-label="More"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  title="More"
                  onClick={() => setMoreOpen((prev) => !prev)}
                >
                  <Icon.dots />
                </button>
                {moreOpen ? (
                  <div
                    role="menu"
                    style={{
                      position: "absolute",
                      top: "calc(100% + 6px)",
                      right: 0,
                      minWidth: 200,
                      background: "var(--bg-1)",
                      border: "1px solid var(--bd-1)",
                      borderRadius: 8,
                      boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
                      padding: 4,
                      zIndex: 10
                    }}
                  >
                    <button
                      role="menuitem"
                      type="button"
                      onClick={handleExport}
                      style={popoverItemStyle}
                    >
                      Export list
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
            <p className="muted" style={{ fontSize: 12, margin: "2px 2px 8px" }}>
              Showing {filtered.length} of {rows.length} models
              {filteredCustom.length > 0 ? ` · ${filteredCustom.length} custom` : ""}
            </p>

            <div className="models-lib__rows">
              {filtered.map((row) => {
                const accountEnabled = isAccountEnabled(row.account.id);
                const bindingEnabled = row.enabled ?? true;
                const enabled = accountEnabled && bindingEnabled;
                const selectedActive = row.id === selectedBindingId;
                const ctx = formatContext(row);
                const isDefault = row.account.is_default && enabled;
                const routeState = enabled ? "Route enabled" : accountEnabled ? "Model disabled" : `Account ${row.account.status}`;
                const routeMeta = [
                  routeState,
                  ctx ? `${ctx} context` : null,
                  priceSummary(row)
                ].filter(Boolean).join(" / ");
                return (
                  <div
                    key={row.id}
                    className={`model-row ${selectedActive ? "on" : ""} ${enabled ? "" : "model-row--disabled-route"}`}
                  >
                    <button
                      type="button"
                      className="model-row__select"
                      onClick={() => setSelectedBindingId(row.id)}
                    >
                      <ProviderBadge id={row.account.provider} size={24} />
                      <span className="model-row__body">
                        <span className="model-row__name">
                          {row.display_name || row.model}
                          {isDefault ? <span className="model-row__default" aria-label="Default">✓</span> : null}
                        </span>
                        {routeMeta ? <span className="model-row__ctx">{routeMeta}</span> : null}
                      </span>
                    </button>
                  </div>
                );
              })}

              {filteredCustom.length > 0 ? (
                <div style={{ marginTop: 12 }}>
                  <p className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, margin: "0 2px 6px" }}>
                    Custom (local)
                  </p>
                  {filteredCustom.map((entry) => (
                    <div key={entry.id} className="model-row" style={{ cursor: "default" }}>
                      <ProviderBadge id={entry.provider} size={24} />
                      <span className="model-row__body">
                        <span className="model-row__name">{entry.displayName || entry.modelId}</span>
                        <span className="model-row__ctx">{entry.modelId}</span>
                      </span>
                      <button
                        type="button"
                        className="ib"
                        aria-label={`Remove ${entry.displayName}`}
                        title="Remove"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleRemoveCustomModel(entry.id);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              {filtered.length === 0 && filteredCustom.length === 0 ? (
                <div className="empty-state">No models match. Adjust the category or search.</div>
              ) : null}
            </div>
          </section>

          <section className="models-lib__detail" aria-label="Model detail">
            {selected ? <ModelDetail row={selected} tab={detailTab} onTabChange={setDetailTab} /> : (
              <div className="empty-state">Select a model to see details.</div>
            )}
          </section>
        </div>
      ) : null}

      {addOpen ? <AddCustomModelDialog onClose={() => setAddOpen(false)} onSubmit={handleAddCustomModel} /> : null}
    </section>
  );
}

const popoverItemStyle: CSSProperties = {
  display: "block",
  width: "100%",
  padding: "8px 10px",
  textAlign: "left",
  background: "transparent",
  border: 0,
  borderRadius: 6,
  font: "inherit",
  color: "var(--ink-1)",
  cursor: "pointer"
};

function ModelsHeader({ tab, onTabChange, onAdd }: { tab: ModelTab; onTabChange: (tab: ModelTab) => void; onAdd: () => void }) {
  return (
    <>
      <header className="models-lib__head">
        <div>
          <h1>Models</h1>
          <p className="sub">Manage your models and add custom models</p>
        </div>
        <button className="button button--primary" type="button" onClick={onAdd}>
          Add custom model
        </button>
      </header>
      <div className="models-lib__tabs" role="tablist" aria-label="Model panel tabs">
        <button
          role="tab"
          aria-selected={tab === "models"}
          className={`models-lib__tab ${tab === "models" ? "on" : ""}`}
          onClick={() => onTabChange("models")}
          type="button"
        >
          Models
        </button>
        <button
          role="tab"
          aria-selected={tab === "settings"}
          className={`models-lib__tab ${tab === "settings" ? "on" : ""}`}
          onClick={() => onTabChange("settings")}
          type="button"
        >
          Global settings
        </button>
      </div>
    </>
  );
}

function ModelDetail({ row, tab, onTabChange }: { row: ModelRow; tab: DetailTab; onTabChange: (tab: DetailTab) => void }) {
  const meta = providerMeta(row.account.provider);
  const ctx = formatContext(row);
  const pricing = readPricing(row);
  const pricingKnown = hasPricing(row);
  const hasPriceValues = Object.values(pricing).some((value) => value !== null && Number.isFinite(value));
  const overrides = (row.capability_overrides ?? null) as Record<string, unknown> | null;
  const releaseDate = (overrides?.releaseDate ?? overrides?.release_date ?? null) as string | null;
  const knowledgeCutoff = (overrides?.knowledgeCutoff ?? overrides?.knowledge_cutoff ?? null) as string | null;
  const apiType = (overrides?.apiType ?? overrides?.api_type ?? null) as string | null;
  const description = (overrides?.description ?? null) as string | null;
  const providerTools = PROVIDER_TOOLS[row.account.provider] ?? [];
  const accountEnabled = isRuntimeEnabledStatus(row.account.status);
  const bindingEnabled = row.enabled ?? true;
  const routeEnabled = accountEnabled && bindingEnabled;

  const parameterEntries = useMemo(() => {
    const source = overrides ?? {};
    return PARAM_LABELS
      .map((entry) => {
        const key = entry.keys.find((candidate) => source[candidate] !== undefined && source[candidate] !== null);
        if (!key) return null;
        const raw = source[key];
        const value = entry.format ? entry.format(raw) : String(raw);
        return { label: entry.label, value };
      })
      .filter((entry): entry is { label: string; value: string } => entry !== null);
  }, [overrides]);

  return (
    <>
      <header className="model-detail__head">
        <ProviderBadge id={row.account.provider} size={28} />
        <div className="model-detail__title">{row.display_name || row.model}</div>
        <StatusBadge tone={routeEnabled ? "success" : "neutral"}>{routeEnabled ? "Route enabled" : "Route disabled"}</StatusBadge>
        {row.account.is_default ? <span className="model-detail__default"><span>✓</span> Default</span> : null}
      </header>

      {!routeEnabled ? (
        <div className="model-detail__warning" role="status">
          {accountEnabled ? "This model binding is disabled and will not be offered as a runtime route." : "This provider account is disabled, so its models are hidden from runtime routing."}
        </div>
      ) : null}

      <div className="models-lib__tabs" role="tablist" aria-label="Detail tabs">
        <button
          role="tab"
          aria-selected={tab === "overview"}
          className={`models-lib__tab ${tab === "overview" ? "on" : ""}`}
          onClick={() => onTabChange("overview")}
          type="button"
        >
          Overview
        </button>
        <button
          role="tab"
          aria-selected={tab === "parameters"}
          className={`models-lib__tab ${tab === "parameters" ? "on" : ""}`}
          onClick={() => onTabChange("parameters")}
          type="button"
        >
          Parameters
        </button>
      </div>

      {tab === "overview" ? (
        <dl className="model-detail__grid">
          {description ? (
            <p className="muted" style={{ gridColumn: "1 / -1", margin: "12px 0 4px" }}>{description}</p>
          ) : null}

          <dt>Model ID</dt>
          <dd>{row.model ?? "—"}</dd>

          <dt>Provider</dt>
          <dd>{meta.name}</dd>

          <dt>Provider account</dt>
          <dd>{row.account.display_name} ({row.account.scope})</dd>

          <dt>Route status</dt>
          <dd className="model-detail__status">
            <StatusBadge tone={accountEnabled ? "success" : "neutral"}>{accountEnabled ? "Account enabled" : `Account ${row.account.status}`}</StatusBadge>
            <StatusBadge tone={bindingEnabled ? "success" : "neutral"}>{bindingEnabled ? "Model enabled" : "Model disabled"}</StatusBadge>
          </dd>

          <dt>Context length</dt>
          <dd>{ctx ?? "—"}</dd>

          <dt>API type</dt>
          <dd>{apiType ?? meta.id}</dd>

          <dt>Release date</dt>
          <dd>{releaseDate ?? "—"}</dd>

          <dt>Knowledge cutoff</dt>
          <dd>{knowledgeCutoff ?? "—"}</dd>

          <dt>Pricing /1M tokens</dt>
          <dd className="model-detail__pricing">
            {pricingKnown && hasPriceValues ? (
              <>
                <PriceChip icon="↓" value={pricing.input} />
                <PriceChip icon="↑" value={pricing.output} />
                <PriceChip icon="↻" value={pricing.cacheRead} />
                <PriceChip icon="⟳" value={pricing.cacheWrite} />
                <PriceChip icon="S" value={pricing.search} />
              </>
            ) : (
              <span className="muted">Unknown pricing</span>
            )}
          </dd>

          <dt>Features</dt>
          <dd className="model-detail__features">
            {FEATURE_CATALOG.map((feature) => {
              const active = feature.providerAllowed.includes(row.account.provider);
              return (
                <span key={feature.id} className={`feature-chip ${active ? "on" : "off"}`}>
                  <span className="feature-chip__dot" aria-hidden="true" />
                  {feature.label}
                </span>
              );
            })}
          </dd>

          {providerTools.length > 0 ? (
            <>
              <dt>Provider tools</dt>
              <dd className="model-detail__tools">
                {providerTools.map((tool) => (
                  <span key={tool.id} className="tool-chip">
                    <span className="tool-chip__dot" aria-hidden="true" />
                    {tool.label}
                  </span>
                ))}
              </dd>
            </>
          ) : null}
        </dl>
      ) : (
        <div className="model-detail__params">
          <p className="muted">Parameters overrides are read-only in this view. Edit them from the draft of an agent that binds to this model.</p>
          {parameterEntries.length > 0 ? (
            <dl className="model-detail__grid" style={{ marginTop: 8 }}>
              {parameterEntries.map((entry) => (
                <Fragment key={entry.label}>
                  <dt>{entry.label}</dt>
                  <dd>{entry.value}</dd>
                </Fragment>
              ))}
            </dl>
          ) : (
            <p className="muted" style={{ marginTop: 8 }}>No tunable parameters set on this binding.</p>
          )}
        </div>
      )}
    </>
  );
}

function PriceChip({ icon, value }: { icon: string; value: number | null }) {
  if (value == null || !Number.isFinite(value)) return null;
  return (
    <span className="price-chip">
      <span className="price-chip__icon" aria-hidden="true">{icon}</span>
      ${value}
    </span>
  );
}

function AddCustomModelDialog({
  onClose,
  onSubmit
}: {
  onClose: () => void;
  onSubmit: (entry: CustomModel) => void;
}) {
  const [provider, setProvider] = useState<string>(Object.keys(PROVIDERS)[0] ?? "openai-compatible");
  const [displayName, setDisplayName] = useState("");
  const [modelId, setModelId] = useState("");
  const [contextLength, setContextLength] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!displayName.trim() || !modelId.trim()) return;
    const ctx = contextLength.trim() ? Number(contextLength) : NaN;
    const entry: CustomModel = {
      id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `cm-${Date.now()}`,
      provider,
      displayName: displayName.trim(),
      modelId: modelId.trim(),
      contextLength: Number.isFinite(ctx) && ctx > 0 ? ctx : null,
      notes: notes.trim(),
      createdAt: new Date().toISOString()
    };
    onSubmit(entry);
  }

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 17, 22, 0.55)",
        display: "grid",
        placeItems: "center",
        zIndex: 100
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-custom-model-title"
        onSubmit={handleSubmit}
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--bd-1)",
          borderRadius: 12,
          width: "min(480px, calc(100vw - 48px))",
          padding: 20,
          display: "grid",
          gap: 12,
          boxShadow: "0 24px 60px rgba(0,0,0,0.35)"
        }}
      >
        <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <h2 id="add-custom-model-title" style={{ margin: 0, fontSize: 18 }}>Add custom model</h2>
          <button type="button" className="ib" aria-label="Close" onClick={onClose}>×</button>
        </header>

        <label style={fieldLabelStyle}>
          <span>Provider</span>
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            style={fieldInputStyle}
          >
            {Object.entries(PROVIDERS).map(([id, meta]) => (
              <option key={id} value={id}>{meta.name}</option>
            ))}
          </select>
        </label>

        <label style={fieldLabelStyle}>
          <span>Display name</span>
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="e.g. Claude Opus 4.7"
            required
            style={fieldInputStyle}
          />
        </label>

        <label style={fieldLabelStyle}>
          <span>Model ID</span>
          <input
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            placeholder="e.g. claude-opus-4-7"
            required
            style={fieldInputStyle}
          />
        </label>

        <label style={fieldLabelStyle}>
          <span>Context length</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={contextLength}
            onChange={(event) => setContextLength(event.target.value)}
            placeholder="200000"
            style={fieldInputStyle}
          />
        </label>

        <label style={fieldLabelStyle}>
          <span>Notes</span>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            style={{ ...fieldInputStyle, resize: "vertical", minHeight: 60 }}
          />
        </label>

        <footer style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="button button--primary">Save locally</button>
        </footer>
      </form>
    </div>
  );
}

const fieldLabelStyle: CSSProperties = {
  display: "grid",
  gap: 4,
  fontSize: 12,
  color: "var(--ink-2)"
};

const fieldInputStyle: CSSProperties = {
  font: "inherit",
  color: "var(--ink-1)",
  background: "var(--bg-2)",
  border: "1px solid var(--bd-1)",
  borderRadius: 8,
  padding: "8px 10px"
};
