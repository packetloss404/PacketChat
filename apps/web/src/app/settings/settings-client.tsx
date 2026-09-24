"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { setTheme, useTheme } from "../../components/app-shell";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/ui";

type SectionId = "data" | "apikeys" | "general" | "appearance" | "shortcuts";

type SectionGroup = {
  label: string;
  items: Array<{ id: SectionId; label: string; icon: React.ReactNode }>;
};

const groups: SectionGroup[] = [
  {
    label: "Account & Data",
    items: [
      { id: "data", label: "App Data & Storage", icon: <Icon.database /> },
      { id: "apikeys", label: "API Keys", icon: <Icon.key /> }
    ]
  },
  {
    label: "Preferences",
    items: [
      { id: "general", label: "General", icon: <Icon.gear /> },
      { id: "appearance", label: "Appearance", icon: <Icon.paint /> },
      { id: "shortcuts", label: "Keyboard Shortcuts", icon: <Icon.keyboard /> }
    ]
  }
];

export function SettingsClient() {
  const [active, setActive] = useState<SectionId>("data");

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
        ) : active === "general" ? (
          <GeneralSection />
        ) : active === "appearance" ? (
          <AppearanceSection />
        ) : active === "shortcuts" ? (
          <ShortcutsSection />
        ) : null}
      </main>
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
      <p className="muted" style={{ margin: 0 }}>
        Chats, prompts, projects, provider accounts, knowledge metadata, and usage records live in the PacketChat server database. Uploaded files live in object storage. Browser storage is only used for UI preferences and local preview drafts.
      </p>

      <h2>Backups</h2>
      <p className="muted" style={{ margin: 0 }}>
        Operators should use the backup and restore scripts documented in <code>docs/runbooks/backup-restore.md</code>. This page does not delete or export server data.
      </p>

      <div className="settings__button-row">
        <Link href="/chat" className="button button--primary">
          <Icon.chat /> Open chats
        </Link>
        <Link href="/knowledge" className="button button--primary">
          <Icon.database /> Open knowledge
        </Link>
      </div>
    </section>
  );
}

// -----------------------------------------------------------------------------
// API keys
// -----------------------------------------------------------------------------

function ApiKeysSection() {
  return (
    <section className="settings__section apikeys">
      <h1>API Keys</h1>
      <p className="muted" style={{ margin: 0 }}>
        Provider credentials are encrypted server-side as provider accounts. Provider keys are app-wide and managed by administrators.
      </p>

      <div className="settings__button-row">
        <Link href="/providers" className="button button--primary">
          <Icon.key /> Manage models
        </Link>
      </div>

      <details className="apikeys__troubleshoot">
        <summary>API key not working?</summary>
        <p className="muted" style={{ marginTop: 8 }}>
          Use the Models page to test the account. Double-check that the key is enabled, the base URL is correct, billing has headroom, and the selected model or Azure deployment exists.
        </p>
      </details>

      <p style={{ textAlign: "center", marginTop: 4 }}>
        <a className="settings__link settings__link--inline" href="https://openrouter.ai/docs/quick-start" target="_blank" rel="noreferrer">
          → Using OpenRouter? See instructions here
        </a>
      </p>
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

function GeneralSection() {
  const [autosave, setAutosave] = usePersistedBool("general", "autosaveDrafts", GENERAL_DEFAULTS.autosaveDrafts);
  const [sendOnEnter, setSendOnEnter] = usePersistedBool("general", "sendOnEnter", GENERAL_DEFAULTS.sendOnEnter);
  const [tokens, setTokens] = usePersistedBool("general", "showTokenCounts", GENERAL_DEFAULTS.showTokenCounts);
  const [fontSize, setFontSize] = usePersistedNumber("general", "composerFontSize", GENERAL_DEFAULTS.composerFontSize);
  const toast = useToast();

  const reset = () => {
    setAutosave(GENERAL_DEFAULTS.autosaveDrafts);
    setSendOnEnter(GENERAL_DEFAULTS.sendOnEnter);
    setTokens(GENERAL_DEFAULTS.showTokenCounts);
    setFontSize(GENERAL_DEFAULTS.composerFontSize);
    toast({ message: "General preferences reset", variant: "success" });
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

function AppearanceSection() {
  const theme = useTheme();

  return (
    <section className="settings__section">
      <h1>Appearance</h1>
      <p className="muted" style={{ margin: 0 }}>
        Theme changes apply immediately and are stored in this browser.
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
    </section>
  );
}

// -----------------------------------------------------------------------------
// Keyboard Shortcuts
// -----------------------------------------------------------------------------

const SHORTCUTS: Array<{ keys: string[]; action: string }> = [
  { keys: ["Esc"], action: "Close the open panel, menu, or dialog" }
];

function ShortcutsSection() {
  return (
    <section className="settings__section">
      <h1>Keyboard Shortcuts</h1>
      <p className="muted" style={{ margin: 0 }}>
        This is the keyboard shortcut available today.
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
