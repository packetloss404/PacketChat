"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "../../components/icons";

type SectionId =
  | "data"
  | "cloud"
  | "apikeys"
  | "license"
  | "general"
  | "appearance"
  | "shortcuts"
  | "tts"
  | "voice"
  | "mcp"
  | "internal"
  | "extensions"
  | "proxy";

type SectionGroup = {
  label: string;
  items: Array<{ id: SectionId; label: string; icon: React.ReactNode }>;
};

const groups: SectionGroup[] = [
  {
    label: "Account & Data",
    items: [
      { id: "data", label: "App Data & Storage", icon: <Icon.database /> },
      { id: "cloud", label: "Cloud Sync & Backup", icon: <Icon.cloud /> },
      { id: "apikeys", label: "API Keys", icon: <Icon.key /> },
      { id: "license", label: "License Key", icon: <Icon.lock /> }
    ]
  },
  {
    label: "Preferences",
    items: [
      { id: "general", label: "General", icon: <Icon.gear /> },
      { id: "appearance", label: "Appearance", icon: <Icon.paint /> },
      { id: "shortcuts", label: "Keyboard Shortcuts", icon: <Icon.keyboard /> },
      { id: "tts", label: "Text-to-speech", icon: <Icon.speaker /> },
      { id: "voice", label: "Voice Input", icon: <Icon.mic /> }
    ]
  },
  {
    label: "Advanced Settings",
    items: [
      { id: "mcp", label: "Model Context Protocol", icon: <Icon.mcp /> },
      { id: "internal", label: "Internal prompts", icon: <Icon.text /> },
      { id: "extensions", label: "Extensions", icon: <Icon.layers /> },
      { id: "proxy", label: "Proxy & Org ID", icon: <Icon.globe /> }
    ]
  }
];

export function SettingsClient() {
  const [active, setActive] = useState<SectionId>("data");
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  return (
    <div className="settings">
      <aside className="settings__rail" aria-label="Settings sections">
        {groups.map((group) => (
          <div className="settings__group" key={group.label}>
            <div className="settings__group-label">{group.label}</div>
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`settings__rail-item ${active === item.id ? "on" : ""}`}
                onClick={() => setActive(item.id)}
                aria-current={active === item.id ? "page" : undefined}
              >
                <span className="settings__rail-icon" aria-hidden="true">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        ))}
      </aside>

      <main className="settings__content">
        {active === "data" ? (
          <AppDataSection />
        ) : active === "apikeys" ? (
          <ApiKeysSection />
        ) : active === "cloud" ? (
          <CloudSyncSection onToast={showToast} />
        ) : active === "license" ? (
          <LicenseKeySection onToast={showToast} />
        ) : active === "general" ? (
          <GeneralSection onToast={showToast} />
        ) : active === "appearance" ? (
          <AppearanceSection />
        ) : active === "shortcuts" ? (
          <ShortcutsSection />
        ) : active === "tts" ? (
          <TextToSpeechSection />
        ) : active === "voice" ? (
          <VoiceInputSection />
        ) : active === "mcp" ? (
          <McpSection />
        ) : active === "internal" ? (
          <InternalPromptsSection />
        ) : active === "extensions" ? (
          <ExtensionsSection />
        ) : active === "proxy" ? (
          <ProxySection />
        ) : null}
      </main>

      {toast ? (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(20,20,22,0.95)",
            color: "#fff",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 8,
            padding: "10px 16px",
            fontSize: 13,
            zIndex: 9999,
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)"
          }}
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// localStorage helpers
// -----------------------------------------------------------------------------

function settingsKey(section: string, key: string) {
  return `packetchat.settings.${section}.${key}`;
}

function readString(section: string, key: string, fallback = ""): string {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(settingsKey(section, key));
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

function writeString(section: string, key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    if (value === "") window.localStorage.removeItem(settingsKey(section, key));
    else window.localStorage.setItem(settingsKey(section, key), value);
  } catch {
    /* ignore */
  }
}

function usePersistedString(section: string, key: string, fallback = "") {
  const [value, setValue] = useState<string>(fallback);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setValue(readString(section, key, fallback));
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    writeString(section, key, value);
  }, [value, hydrated, section, key]);

  return [value, setValue, hydrated] as const;
}

function usePersistedBool(section: string, key: string, fallback: boolean) {
  const [value, setValue] = useState<boolean>(fallback);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const raw = readString(section, key, "");
    if (raw === "1" || raw === "true") setValue(true);
    else if (raw === "0" || raw === "false") setValue(false);
    else setValue(fallback);
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    writeString(section, key, value ? "1" : "0");
  }, [value, hydrated, section, key]);

  return [value, setValue, hydrated] as const;
}

function usePersistedNumber(section: string, key: string, fallback: number) {
  const [value, setValue] = useState<number>(fallback);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const raw = readString(section, key, "");
    const parsed = raw === "" ? NaN : Number(raw);
    setValue(Number.isFinite(parsed) ? parsed : fallback);
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    writeString(section, key, String(value));
  }, [value, hydrated, section, key]);

  return [value, setValue, hydrated] as const;
}

// -----------------------------------------------------------------------------
// Toggle switch (inline, no css dependency)
// -----------------------------------------------------------------------------

function Switch({
  checked,
  onChange,
  ariaLabel
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      style={{
        position: "relative",
        width: 38,
        height: 22,
        borderRadius: 999,
        border: "1px solid var(--border, rgba(255,255,255,0.16))",
        background: checked ? "var(--accent, #4b8ad6)" : "rgba(255,255,255,0.08)",
        cursor: "pointer",
        transition: "background 120ms ease",
        padding: 0,
        flexShrink: 0
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "#fff",
          transition: "left 140ms ease",
          boxShadow: "0 1px 3px rgba(0,0,0,0.3)"
        }}
      />
    </button>
  );
}

function Row({
  title,
  description,
  control
}: {
  title: string;
  description?: string;
  control: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "12px 0",
        borderBottom: "1px solid rgba(255,255,255,0.06)"
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 500 }}>{title}</div>
        {description ? (
          <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
            {description}
          </div>
        ) : null}
      </div>
      <div style={{ flexShrink: 0 }}>{control}</div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// App Data section (existing)
// -----------------------------------------------------------------------------

function AppDataSection() {
  return (
    <section className="settings__section">
      <h1>App Data &amp; Storage</h1>
      <button type="button" className="settings__link">→ Click to calculate your data usage</button>

      <div className="settings__button-row">
        <button type="button" className="button button--primary">
          <Icon.copy /> Export
        </button>
        <button type="button" className="button button--primary">
          <Icon.copy /> Import
        </button>
        <button type="button" className="button button--danger-solid">
          <Icon.trash /> Delete All Local Data
        </button>
      </div>
      <div className="settings__button-row">
        <button type="button" className="button button--primary">
          <Icon.copy /> Import From OpenAI
        </button>
        <Link href="#" className="settings__link settings__link--inline">How to export data from OpenAI?</Link>
      </div>

      <h2>Archived Chats</h2>
      <div className="settings__button-row">
        <button type="button" className="button button--primary">
          <Icon.database /> View Archived Chats
        </button>
      </div>

      <h2>Storage Stats</h2>
      <p className="muted" style={{ margin: 0 }}>
        All of your data is stored locally in your browser. Each browser has a different limit of how much data you can store. If you are running out of space, you can delete some of your old chats.
      </p>

      <div className="settings__stat">
        <div className="settings__stat-title">
          Metadata &amp; User Data: <Link href="#" className="settings__link settings__link--inline">(View Report)</Link>
        </div>
        <div className="settings__bar"><span style={{ width: "0.03%" }} /></div>
        <div className="settings__stat-meta">
          <span>Local Storage: <strong>0.00 MB (0.03%)</strong></span>
          <span>Limit: <strong>5.00 MB</strong></span>
        </div>
      </div>

      <div className="settings__stat">
        <div className="settings__stat-title">Local Chat Data:</div>
        <div className="settings__bar"><span style={{ width: "0.001%" }} /></div>
        <div className="settings__stat-meta">
          <span>IndexedDB: <strong>439.76 KB</strong></span>
          <span>Limit: <strong>599.49 GB</strong></span>
        </div>
      </div>

      <p className="settings__warning">
        Please export and backup your chats regularly to avoid data lost! <Link href="#" className="settings__link settings__link--inline">Learn how to protect your data.</Link>
      </p>

      <details className="settings__debug">
        <summary>Debug pages</summary>
        <ul>
          <li><Link href="#" className="settings__link settings__link--inline">Service worker state</Link></li>
          <li><Link href="#" className="settings__link settings__link--inline">Cache inspector</Link></li>
          <li><Link href="#" className="settings__link settings__link--inline">Raw IndexedDB dump</Link></li>
        </ul>
      </details>
    </section>
  );
}

// -----------------------------------------------------------------------------
// API keys (existing)
// -----------------------------------------------------------------------------

type ProviderKeyConfig = {
  id: string;
  name: string;
  tint: string;
  glyph: string;
  placeholder: string;
  docsUrl: string;
  optional: string[];
};

const providerKeys: ProviderKeyConfig[] = [
  {
    id: "openai-compatible",
    name: "OpenAI",
    tint: "#10a37f",
    glyph: "O",
    placeholder: "sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    docsUrl: "https://platform.openai.com/api-keys",
    optional: ["Organization ID", "Project ID", "Base URL"]
  },
  {
    id: "anthropic",
    name: "Anthropic",
    tint: "#d97757",
    glyph: "A",
    placeholder: "sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    docsUrl: "https://console.anthropic.com/settings/keys",
    optional: ["Base URL"]
  },
  {
    id: "google",
    name: "Google",
    tint: "#4285f4",
    glyph: "G",
    placeholder: "AIzaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    docsUrl: "https://aistudio.google.com/app/apikey",
    optional: ["Base URL"]
  },
  {
    id: "azure-openai",
    name: "Azure OpenAI",
    tint: "#4b8ad6",
    glyph: "Az",
    placeholder: "your-azure-openai-key",
    docsUrl: "https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/OpenAI",
    optional: ["Resource name", "Deployment", "API version"]
  },
  {
    id: "perplexity",
    name: "Perplexity",
    tint: "#1fb8cd",
    glyph: "P",
    placeholder: "pplx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    docsUrl: "https://www.perplexity.ai/settings/api",
    optional: ["Base URL"]
  },
  {
    id: "minimax",
    name: "MiniMax",
    tint: "#7c3aed",
    glyph: "M",
    placeholder: "your-minimax-key",
    docsUrl: "https://www.minimax.io/platform/user-center/basic-information/interface-key",
    optional: ["Group ID"]
  }
];

function storageKey(providerId: string) {
  return `packetchat.apiKey.${providerId}`;
}

function ProviderKeyRow({ config }: { config: ProviderKeyConfig }) {
  const [value, setValue] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(storageKey(config.id));
    if (stored) setValue(stored);
    setHydrated(true);
  }, [config.id]);

  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;
    if (value) window.localStorage.setItem(storageKey(config.id), value);
    else window.localStorage.removeItem(storageKey(config.id));
  }, [value, hydrated, config.id]);

  const optionalCount = config.optional.length;
  const optionalLabel = optionalCount === 1 ? "Optional field (1)" : `Optional fields (${optionalCount})`;

  return (
    <div className="apikey-row">
      <div className="apikey-row__head">
        <span
          className="apikey-row__badge"
          style={{ background: config.tint }}
          aria-hidden="true"
        >
          {config.glyph}
        </span>
        <span className="apikey-row__name">{config.name}:</span>
        <a className="apikey-row__get" href={config.docsUrl} target="_blank" rel="noreferrer">(Get API key here)</a>
      </div>

      <label className="apikey-row__label">
        API Key <span className="apikey-row__required" aria-hidden="true">*</span>
      </label>
      <input
        type="password"
        className="input apikey-row__input"
        placeholder={config.placeholder}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        aria-label={`${config.name} API key`}
        autoComplete="off"
        spellCheck={false}
      />

      <button
        type="button"
        className="apikey-row__optional"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {optionalLabel}
        <span className={`apikey-row__chev ${open ? "open" : ""}`} aria-hidden="true">
          <Icon.chev />
        </span>
      </button>

      {open ? (
        <div className="apikey-row__optional-body">
          {config.optional.map((field) => (
            <label key={field}>
              {field}
              <input
                type="text"
                className="input"
                placeholder={field}
                aria-label={`${config.name} ${field}`}
              />
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ApiKeysSection() {
  return (
    <section className="settings__section apikeys">
      <h1>API Keys</h1>
      <p className="muted" style={{ margin: 0 }}>
        By default, your API Key is stored locally on your browser and never sent anywhere else.
      </p>

      <div className="apikeys__list">
        {providerKeys.map((config) => (
          <ProviderKeyRow key={config.id} config={config} />
        ))}
      </div>

      <details className="apikeys__troubleshoot">
        <summary>API Key not working? Click Here.</summary>
        <p className="muted" style={{ marginTop: 8 }}>
          Double-check that you&rsquo;ve enabled the correct model family in your provider console, that your key has not been revoked, and that any billing/usage caps have headroom. For Azure and MiniMax you also need the deployment/group IDs set in Optional fields.
        </p>
      </details>

      <p style={{ textAlign: "center", marginTop: 4 }}>
        <a className="settings__link settings__link--inline" href="https://openrouter.ai/docs/quick-start" target="_blank" rel="noreferrer">
          → Using Open Router? See instructions here
        </a>
      </p>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Cloud Sync & Backup
// -----------------------------------------------------------------------------

function CloudSyncSection({ onToast }: { onToast: (msg: string) => void }) {
  const handleExport = () => {
    if (typeof window === "undefined") return;
    const dump: Record<string, string> = {};
    try {
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const k = window.localStorage.key(i);
        if (k === null) continue;
        const v = window.localStorage.getItem(k);
        if (v !== null) dump[k] = v;
      }
    } catch {
      onToast("Could not read localStorage");
      return;
    }

    const payload = {
      app: "PacketChat",
      exportedAt: new Date().toISOString(),
      version: 1,
      data: dump
    };

    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json"
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      a.href = url;
      a.download = `packetchat-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      onToast("Backup downloaded");
    } catch {
      onToast("Backup failed");
    }
  };

  return (
    <section className="settings__section">
      <h1>Cloud Sync &amp; Backup</h1>
      <p className="muted" style={{ margin: 0 }}>
        PacketChat keeps everything in your browser by default. Connect a cloud provider to encrypt and sync your chats, prompts, and preferences across devices, or download a one-off backup right now.
      </p>

      <div className="settings__button-row">
        <button
          type="button"
          className="button button--primary"
          disabled
          title="Requires a Fifty Eleven LLC account"
          style={{ minHeight: 44, padding: "0 20px", fontWeight: 600 }}
        >
          <Icon.cloud /> Connect cloud provider
        </button>
        <span className="muted" style={{ fontSize: 13 }}>
          Requires a Fifty Eleven LLC account
        </span>
      </div>

      <h2>Local backup</h2>
      <p className="muted" style={{ margin: 0 }}>
        Export everything stored under <code>localStorage</code> as a single JSON file. Useful before clearing browser data or moving to a new machine.
      </p>
      <div className="settings__button-row">
        <button type="button" className="button button--primary" onClick={handleExport}>
          <Icon.copy /> Export local backup
        </button>
      </div>
    </section>
  );
}

// -----------------------------------------------------------------------------
// License Key
// -----------------------------------------------------------------------------

function LicenseKeySection({ onToast }: { onToast: (msg: string) => void }) {
  const [value, setValue] = usePersistedString("license", "key", "");

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setValue(text.trim());
      else onToast("Clipboard is empty");
    } catch {
      onToast("Clipboard access denied");
    }
  };

  const handleActivate = () => {
    if (!value.trim()) {
      onToast("Enter a license key first");
      return;
    }
    onToast("License validation service not yet connected");
  };

  return (
    <section className="settings__section">
      <h1>License Key</h1>
      <p className="muted" style={{ margin: 0 }}>
        Paste a license key to unlock paid features. Your key is stored locally in this browser and never sent until validation goes online.
      </p>

      <label className="apikey-row__label" htmlFor="license-key-input">License key</label>
      <input
        id="license-key-input"
        type="text"
        className="input"
        placeholder="PCKT-XXXX-XXXX-XXXX-XXXX"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />

      <div className="settings__button-row">
        <button type="button" className="button button--primary" onClick={handlePaste}>
          <Icon.copy /> Paste license
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => setValue("")}
          disabled={!value}
        >
          Clear
        </button>
        <button type="button" className="button button--primary" onClick={handleActivate}>
          <Icon.lock /> Activate
        </button>
      </div>
    </section>
  );
}

// -----------------------------------------------------------------------------
// General
// -----------------------------------------------------------------------------

const GENERAL_DEFAULTS = {
  autosaveDrafts: true,
  sendOnEnter: true,
  showTokenCounts: false,
  composerFontSize: 14
};

function GeneralSection({ onToast }: { onToast: (msg: string) => void }) {
  const [autosave, setAutosave] = usePersistedBool("general", "autosaveDrafts", GENERAL_DEFAULTS.autosaveDrafts);
  const [sendOnEnter, setSendOnEnter] = usePersistedBool("general", "sendOnEnter", GENERAL_DEFAULTS.sendOnEnter);
  const [tokens, setTokens] = usePersistedBool("general", "showTokenCounts", GENERAL_DEFAULTS.showTokenCounts);
  const [fontSize, setFontSize] = usePersistedNumber("general", "composerFontSize", GENERAL_DEFAULTS.composerFontSize);

  const reset = () => {
    setAutosave(GENERAL_DEFAULTS.autosaveDrafts);
    setSendOnEnter(GENERAL_DEFAULTS.sendOnEnter);
    setTokens(GENERAL_DEFAULTS.showTokenCounts);
    setFontSize(GENERAL_DEFAULTS.composerFontSize);
    onToast("General preferences reset");
  };

  return (
    <section className="settings__section">
      <h1>General</h1>
      <p className="muted" style={{ margin: 0 }}>
        Tweak day-to-day composer behavior. All preferences are stored locally.
      </p>

      <div>
        <Row
          title="Autosave drafts"
          description="Persist whatever you&rsquo;re typing so you don&rsquo;t lose work on refresh."
          control={<Switch checked={autosave} onChange={setAutosave} ariaLabel="Autosave drafts" />}
        />
        <Row
          title="Send on Enter"
          description="When off, Enter inserts a newline and Ctrl/Cmd+Enter sends."
          control={<Switch checked={sendOnEnter} onChange={setSendOnEnter} ariaLabel="Send on Enter" />}
        />
        <Row
          title="Show token counts"
          description="Display approximate token usage under each message."
          control={<Switch checked={tokens} onChange={setTokens} ariaLabel="Show token counts" />}
        />
      </div>

      <h2>Composer font size</h2>
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "8px 0" }}>
        <input
          type="range"
          min={13}
          max={16}
          step={1}
          value={fontSize}
          onChange={(e) => setFontSize(Number(e.target.value))}
          aria-label="Composer font size"
          style={{ flex: 1, maxWidth: 320 }}
        />
        <span style={{ minWidth: 48, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {fontSize}px
        </span>
      </div>

      <div className="settings__button-row">
        <button type="button" className="button button--ghost" onClick={reset}>
          Reset preferences
        </button>
      </div>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Appearance
// -----------------------------------------------------------------------------

const ACCENT_OPTIONS = [
  { id: "azure", label: "Azure" },
  { id: "violet", label: "Violet" },
  { id: "emerald", label: "Emerald" },
  { id: "amber", label: "Amber" },
  { id: "rose", label: "Rose" }
];

function AppearanceSection() {
  const [theme, setTheme] = usePersistedString("appearance", "theme", "dark");
  const [accent, setAccent] = usePersistedString("appearance", "accent", "azure");

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("light", theme === "light");
  }, [theme]);

  return (
    <section className="settings__section">
      <h1>Appearance</h1>
      <p className="muted" style={{ margin: 0 }}>
        Theme changes apply immediately. Accent color is informational for now and will be wired into the UI in a future update.
      </p>

      <h2>Theme</h2>
      <div role="radiogroup" aria-label="Theme" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {(["dark", "light"] as const).map((opt) => {
          const checked = theme === opt;
          return (
            <label
              key={opt}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 14px",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 8,
                cursor: "pointer",
                background: checked ? "rgba(75,138,214,0.12)" : "transparent",
                borderColor: checked ? "var(--accent, #4b8ad6)" : "rgba(255,255,255,0.12)",
                minWidth: 140
              }}
            >
              <input
                type="radio"
                name="theme"
                value={opt}
                checked={checked}
                onChange={() => setTheme(opt)}
              />
              <span style={{ textTransform: "capitalize" }}>{opt}</span>
            </label>
          );
        })}
      </div>

      <h2>Accent color</h2>
      <select
        className="input"
        value={accent}
        onChange={(e) => setAccent(e.target.value)}
        aria-label="Accent color"
        style={{ maxWidth: 280 }}
      >
        {ACCENT_OPTIONS.map((opt) => (
          <option key={opt.id} value={opt.id}>{opt.label}</option>
        ))}
      </select>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Keyboard Shortcuts
// -----------------------------------------------------------------------------

const SHORTCUTS: Array<{ keys: string[]; action: string }> = [
  { keys: ["Ctrl", "K"], action: "Open quick search" },
  { keys: ["Ctrl", "N"], action: "New chat" },
  { keys: ["Ctrl", "Shift", "N"], action: "New chat in fresh window" },
  { keys: ["Ctrl", "/"], action: "Toggle sidebar" },
  { keys: ["Ctrl", "Enter"], action: "Send message (when Send on Enter is off)" },
  { keys: ["Ctrl", ","], action: "Open settings" },
  { keys: ["Ctrl", "Shift", "C"], action: "Copy last assistant reply" },
  { keys: ["Esc"], action: "Stop streaming response" },
  { keys: ["Ctrl", "B"], action: "Bookmark current chat" },
  { keys: ["Ctrl", "Shift", "P"], action: "Open command palette" }
];

function ShortcutsSection() {
  return (
    <section className="settings__section">
      <h1>Keyboard Shortcuts</h1>
      <p className="muted" style={{ margin: 0 }}>
        Hold-and-tap combinations work across the app. Replace <kbd>Ctrl</kbd> with <kbd>Cmd</kbd> on macOS.
      </p>

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(255,255,255,0.12)" }}>
            <th style={{ padding: "10px 12px", fontWeight: 600, fontSize: 13 }}>Shortcut</th>
            <th style={{ padding: "10px 12px", fontWeight: 600, fontSize: 13 }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.action} style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              <td style={{ padding: "10px 12px" }}>
                {s.keys.map((k, i) => (
                  <span key={`${s.action}-${k}-${i}`}>
                    <kbd
                      style={{
                        display: "inline-block",
                        padding: "2px 8px",
                        margin: "0 2px",
                        border: "1px solid rgba(255,255,255,0.18)",
                        borderRadius: 4,
                        background: "rgba(255,255,255,0.05)",
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                        fontSize: 12
                      }}
                    >
                      {k}
                    </kbd>
                    {i < s.keys.length - 1 ? <span style={{ opacity: 0.5 }}> + </span> : null}
                  </span>
                ))}
              </td>
              <td style={{ padding: "10px 12px", fontSize: 14 }}>{s.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Text-to-speech
// -----------------------------------------------------------------------------

function TextToSpeechSection() {
  const [enabled, setEnabled] = usePersistedBool("tts", "enabled", false);
  const [voiceURI, setVoiceURI] = usePersistedString("tts", "voiceURI", "");
  const [rate, setRate] = usePersistedNumber("tts", "rate", 1);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const synth = window.speechSynthesis;
    const update = () => setVoices(synth.getVoices());
    update();
    synth.addEventListener?.("voiceschanged", update);
    return () => {
      synth.removeEventListener?.("voiceschanged", update);
    };
  }, []);

  const handleTest = () => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const synth = window.speechSynthesis;
    synth.cancel();
    const utter = new SpeechSynthesisUtterance("PacketChat voice preview");
    utter.rate = rate;
    if (voiceURI) {
      const match = voices.find((v) => v.voiceURI === voiceURI);
      if (match) utter.voice = match;
    }
    synth.speak(utter);
  };

  const ttsAvailable = typeof window !== "undefined" && !!window.speechSynthesis;

  return (
    <section className="settings__section">
      <h1>Text-to-speech</h1>
      <p className="muted" style={{ margin: 0 }}>
        Uses your browser&rsquo;s built-in speech synthesis. Available voices depend on your operating system.
      </p>

      <Row
        title="Enable text-to-speech"
        description="Adds a speak button next to assistant replies."
        control={<Switch checked={enabled} onChange={setEnabled} ariaLabel="Enable text-to-speech" />}
      />

      <h2>Voice</h2>
      <select
        className="input"
        value={voiceURI}
        onChange={(e) => setVoiceURI(e.target.value)}
        aria-label="Voice"
        disabled={!ttsAvailable || voices.length === 0}
        style={{ maxWidth: 420 }}
      >
        <option value="">System default</option>
        {voices.map((v) => (
          <option key={v.voiceURI} value={v.voiceURI}>
            {v.name} ({v.lang}){v.default ? " — default" : ""}
          </option>
        ))}
      </select>

      <h2>Rate</h2>
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "8px 0" }}>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.1}
          value={rate}
          onChange={(e) => setRate(Number(e.target.value))}
          aria-label="Speech rate"
          style={{ flex: 1, maxWidth: 320 }}
        />
        <span style={{ minWidth: 48, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {rate.toFixed(1)}x
        </span>
      </div>

      <div className="settings__button-row">
        <button
          type="button"
          className="button button--primary"
          onClick={handleTest}
          disabled={!ttsAvailable}
        >
          <Icon.speaker /> Test
        </button>
      </div>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Voice Input
// -----------------------------------------------------------------------------

function VoiceInputSection() {
  const [enabled, setEnabled] = usePersistedBool("voice", "enabled", false);

  return (
    <section className="settings__section">
      <h1>Voice Input</h1>
      <p className="muted" style={{ margin: 0 }}>
        Voice input relies on your browser&rsquo;s Speech Recognition API (<code>webkitSpeechRecognition</code> / <code>SpeechRecognition</code>). Quality and language support vary by browser; Chrome and Edge work best, Firefox is currently unsupported.
      </p>

      <Row
        title="Enable voice input"
        description="Show a microphone button in the composer to dictate messages."
        control={<Switch checked={enabled} onChange={setEnabled} ariaLabel="Enable voice input" />}
      />
    </section>
  );
}

// -----------------------------------------------------------------------------
// Model Context Protocol
// -----------------------------------------------------------------------------

type McpServer = { id: string; name: string; url: string; status: "connected" | "idle" | "error" };

const MCP_SEEDS: McpServer[] = [
  { id: "fs-local", name: "Filesystem", url: "stdio://mcp-server-fs", status: "connected" },
  { id: "github", name: "GitHub", url: "https://mcp.github.com", status: "idle" },
  { id: "search-web", name: "Web Search", url: "https://mcp.search.example", status: "error" }
];

function McpSection() {
  const [servers, setServers] = useState<McpServer[]>(MCP_SEEDS);
  const [hydrated, setHydrated] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftUrl, setDraftUrl] = useState("");

  useEffect(() => {
    const raw = readString("mcp", "servers", "");
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as McpServer[];
        if (Array.isArray(parsed)) setServers(parsed);
      } catch {
        /* keep seeds */
      }
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    writeString("mcp", "servers", JSON.stringify(servers));
  }, [servers, hydrated]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = draftName.trim();
    const url = draftUrl.trim();
    if (!name || !url) return;
    const next: McpServer = {
      id: `${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`,
      name,
      url,
      status: "idle"
    };
    setServers((prev) => [...prev, next]);
    setDraftName("");
    setDraftUrl("");
    setAdding(false);
  };

  const remove = (id: string) => {
    setServers((prev) => prev.filter((s) => s.id !== id));
  };

  const statusColor = (s: McpServer["status"]) =>
    s === "connected" ? "#10a37f" : s === "error" ? "#d9534f" : "#9aa0a6";

  return (
    <section className="settings__section">
      <h1>Model Context Protocol</h1>
      <p className="muted" style={{ margin: 0 }}>
        Connect MCP servers to give models access to local tools, files, or APIs. Servers are stored locally and dialed on demand.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
        {servers.map((s) => (
          <div
            key={s.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 12px",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 8
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: statusColor(s.status),
                flexShrink: 0
              }}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 500 }}>{s.name}</div>
              <div className="muted" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.url}
              </div>
            </div>
            <span className="muted" style={{ fontSize: 12, textTransform: "capitalize" }}>{s.status}</span>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => remove(s.id)}
              aria-label={`Remove ${s.name}`}
            >
              <Icon.trash />
            </button>
          </div>
        ))}
      </div>

      {adding ? (
        <form onSubmit={submit} style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <label className="apikey-row__label">Server name</label>
          <input
            type="text"
            className="input"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="My MCP Server"
            autoFocus
            required
          />
          <label className="apikey-row__label">URL</label>
          <input
            type="text"
            className="input"
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            placeholder="https://mcp.example.com or stdio://command"
            required
          />
          <div className="settings__button-row">
            <button type="submit" className="button button--primary">
              <Icon.plus /> Save server
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => {
                setAdding(false);
                setDraftName("");
                setDraftUrl("");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="settings__button-row">
          <button type="button" className="button button--primary" onClick={() => setAdding(true)}>
            <Icon.plus /> Add server
          </button>
        </div>
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------
// Internal prompts
// -----------------------------------------------------------------------------

function InternalPromptsSection() {
  const [prompt, setPrompt] = usePersistedString("internal", "systemPrompt", "");
  const ref = useRef<HTMLTextAreaElement>(null);

  const charCount = useMemo(() => prompt.length, [prompt]);

  return (
    <section className="settings__section">
      <h1>Internal prompts</h1>
      <p className="muted" style={{ margin: 0 }}>
        This text is appended to the system prompt of every chat. Use it to set tone, persona, or reminders that apply across conversations.
      </p>

      <label className="apikey-row__label" htmlFor="internal-system-prompt">Custom system prompt</label>
      <textarea
        id="internal-system-prompt"
        ref={ref}
        className="input"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="You are PacketChat, a careful, succinct assistant..."
        rows={10}
        style={{
          width: "100%",
          minHeight: 180,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 13,
          lineHeight: 1.5,
          resize: "vertical"
        }}
      />
      <div
        className="muted"
        style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}
      >
        <span>Saved automatically.</span>
        <span>{charCount} characters</span>
      </div>

      <div className="settings__button-row">
        <button
          type="button"
          className="button button--ghost"
          onClick={() => setPrompt("")}
          disabled={!prompt}
        >
          Clear prompt
        </button>
      </div>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Extensions
// -----------------------------------------------------------------------------

const EXTENSIONS = [
  {
    id: "weather",
    name: "Weather Tools",
    description: "Lets the model fetch current conditions and forecasts for any location.",
    publisher: "Fifty Eleven Labs"
  },
  {
    id: "code-interpreter",
    name: "Code Interpreter",
    description: "Runs Python and JavaScript snippets in a sandboxed worker for analysis and plotting.",
    publisher: "PacketChat Core"
  }
];

function ExtensionsSection() {
  return (
    <section className="settings__section">
      <h1>Extensions</h1>
      <p className="muted" style={{ margin: 0 }}>
        Optional packages that add tools or rendering capabilities. The extension marketplace will go live alongside Cloud Sync.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
        {EXTENSIONS.map((ext) => (
          <div
            key={ext.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              padding: "14px 16px",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 10
            }}
          >
            <div
              aria-hidden="true"
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: "rgba(255,255,255,0.06)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0
              }}
            >
              <Icon.layers />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500 }}>{ext.name}</div>
              <div className="muted" style={{ fontSize: 13 }}>{ext.description}</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>by {ext.publisher}</div>
            </div>
            <button
              type="button"
              className="button button--primary"
              disabled
              title="Marketplace not yet available"
            >
              Install
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Proxy & Org ID
// -----------------------------------------------------------------------------

function ProxySection() {
  const [proxy, setProxy] = usePersistedString("proxy", "httpsUrl", "");
  const [orgId, setOrgId] = usePersistedString("proxy", "openaiOrgId", "");

  return (
    <section className="settings__section">
      <h1>Proxy &amp; Org ID</h1>
      <p className="muted" style={{ margin: 0 }}>
        Route provider traffic through a corporate proxy and attach an OpenAI-style organization header. Both values are stored locally.
      </p>

      <label className="apikey-row__label" htmlFor="proxy-url">HTTPS proxy URL</label>
      <input
        id="proxy-url"
        type="text"
        className="input"
        value={proxy}
        onChange={(e) => setProxy(e.target.value)}
        placeholder="https://user:pass@proxy.internal:8443"
        autoComplete="off"
        spellCheck={false}
      />

      <label className="apikey-row__label" htmlFor="org-id" style={{ marginTop: 12 }}>OpenAI Organization ID</label>
      <input
        id="org-id"
        type="text"
        className="input"
        value={orgId}
        onChange={(e) => setOrgId(e.target.value)}
        placeholder="org-XXXXXXXXXXXXXXXXXXXXXXXX"
        autoComplete="off"
        spellCheck={false}
      />

      <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        Leave blank to use direct connections and the default organization on your account.
      </p>
    </section>
  );
}
