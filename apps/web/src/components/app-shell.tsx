"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "../lib/api-client";
import { changePassword, getAccessToken } from "../lib/auth-client";
import { useAuth } from "./auth-provider";
import { Icon } from "./icons";
import { useToast } from "./ui";

type NavItem = {
  id: string;
  label: string;
  href: string;
  icon: React.ReactNode;
  badge?: string;
};

const primaryNav: NavItem[] = [
  { id: "chats", label: "Chats", href: "/chat", icon: <Icon.chat /> },
  { id: "agents", label: "Agents", href: "/agents", icon: <Icon.grid /> },
  { id: "providers", label: "Models", href: "/providers", icon: <Icon.key /> },
  { id: "projects", label: "Projects", href: "/projects", icon: <Icon.folder /> },
  { id: "prompts", label: "Prompts", href: "/prompts", icon: <Icon.text /> },
  { id: "knowledge", label: "Knowledge", href: "/knowledge", icon: <Icon.layers /> },
  { id: "users", label: "Users", href: "/admin/users", icon: <Icon.users /> },
  { id: "usage", label: "Usage", href: "/admin/usage", icon: <Icon.mixer /> }
];

const pluginsNav: NavItem[] = [
  { id: "marketplace", label: "Agent Marketplace", href: "/plugins/marketplace", icon: <Icon.layers /> },
  { id: "plugins", label: "Plugins", href: "/plugins", icon: <Icon.mcp /> }
];

const routeTitles: Array<{ match: (p: string) => boolean; title: string }> = [
  { match: (p) => p.startsWith("/plugins/marketplace"), title: "Agent Marketplace" },
  { match: (p) => p === "/plugins" || p.startsWith("/plugins/"), title: "Plugins" },
  { match: (p) => p.startsWith("/agents"), title: "Agents" },
  { match: (p) => p.startsWith("/providers"), title: "Models" },
  { match: (p) => p.startsWith("/projects"), title: "Projects" },
  { match: (p) => p.startsWith("/prompts"), title: "Prompt library" },
  { match: (p) => p.startsWith("/knowledge"), title: "Knowledge" },
  { match: (p) => p.startsWith("/admin/users"), title: "Users" },
  { match: (p) => p.startsWith("/admin/usage"), title: "Usage" },
  { match: (p) => p.startsWith("/login"), title: "Sign in" },
  { match: (p) => p.startsWith("/settings"), title: "Settings" },
  { match: (p) => p.startsWith("/chat"), title: "Chat" }
];

function isActivePath(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function userInitials(name: string) {
  const parts = name.split(/[.\s_-]+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function resolveTitle(pathname: string) {
  const hit = routeTitles.find((entry) => entry.match(pathname));
  return hit?.title ?? "PacketChat";
}

function LeftRail() {
  const pathname = usePathname() ?? "/";
  const { user } = useAuth();
  const displayName = user?.displayName || user?.email?.split("@")[0] || "Guest";
  const initials = useMemo(() => userInitials(displayName), [displayName]);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const toast = useToast();
  const visiblePrimaryNav = useMemo(() => primaryNav.filter((item) => !item.href.startsWith("/admin") || user?.role === "admin"), [user?.role]);

  useEffect(() => {
    if (!user) return;
    if (typeof window === "undefined") return;
    if (!getAccessToken()) return;

    let cancelled = false;

    const apply = (id: string, value: string) => {
      if (cancelled) return;
      setCounts((prev) => (prev[id] === value ? prev : { ...prev, [id]: value }));
    };

    apiClient.conversations
      .list()
      .then((res) => apply("chats", String((res.conversations ?? []).length)))
      .catch(() => undefined);

    apiClient.agents
      .list()
      .then((res) => apply("agents", String(res.agents.length)))
      .catch(() => undefined);

    apiClient.providers
      .list()
      .then((res) => {
        const total = res.accounts.length;
        const enabled = res.accounts.filter((account) => account.status === "enabled").length;
        apply("providers", `${enabled}/${total}`);
      })
      .catch(() => undefined);

    apiClient.projects
      .list()
      .then((res) => apply("projects", String(res.projects.length)))
      .catch(() => undefined);

    apiClient.prompts
      .list()
      .then((res) => apply("prompts", String(res.prompts.length)))
      .catch(() => undefined);

    apiClient.knowledge
      .list()
      .then((res) => apply("knowledge", String(res.knowledgeBases.length)))
      .catch(() => undefined);

    if (user.role === "admin") {
      apiClient.admin.users
        .list()
        .then((res) => apply("users", String(res.users.length)))
        .catch(() => undefined);
    }

    return () => {
      cancelled = true;
    };
  }, [user]);

  return (
    <aside className="lr" aria-label="Primary navigation">
      <div className="lr__top">
        <button
          className="ib ib--preview"
          type="button"
          title="Collapse sidebar (preview)"
          aria-label="Collapse sidebar (preview)"
          onClick={() => toast({ message: "Sidebar collapse is coming soon.", variant: "info" })}
        >
          <Icon.sidebar />
          <span className="preview-dot" aria-hidden="true">Preview</span>
        </button>
        <div className="brand">
          packet<span>chat</span>
        </div>
        <button
          className="ib ib--preview"
          type="button"
          title="Bookmarks panel (preview)"
          aria-label="Bookmarks panel (preview)"
          onClick={() => toast({ message: "Use the right Bookmarks panel for saved assistant messages. Full shortcut is coming soon.", variant: "info" })}
        >
          <Icon.bookmark />
          <span className="preview-dot" aria-hidden="true">Preview</span>
        </button>
        <Link className="ib" href="/chat" title="New chat" aria-label="New chat">
          <Icon.edit />
        </Link>
      </div>

      <label className="lr__search lr__search--preview" aria-label="Search messages (preview)">
        <Icon.search />
        <input
          placeholder="Search messages"
          aria-label="Search messages (preview)"
          onFocus={() => toast({ message: "Message search is coming soon.", variant: "info" })}
        />
        <span className="inline-preview" aria-hidden="true">Preview</span>
      </label>

      <nav className="lr__nav" aria-label="Primary sections">
        {visiblePrimaryNav.map((item) => {
          const active = isActivePath(pathname, item.href);
          const badge = counts[item.id] ?? item.badge;
          const link = (
            <Link key={item.id} href={item.href} aria-current={active ? "page" : undefined} className={active ? "on" : undefined}>
              {item.icon}
              <span>{item.label}</span>
              {badge ? <span className="badge">{badge}</span> : null}
            </Link>
          );

          if (item.id !== "chats") return link;

          return (
            <div className="lr__nav-group" key={item.id}>
              {link}
              <div className="lr__nav-children" aria-label="Recent chats">
                <div className="lr__group">
                  <h4>Recent chats</h4>
                  <p className="muted" style={{ margin: "4px 12px 8px", fontSize: 12 }}>
                    Chats appear here after you start them.
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </nav>

      <div className="lr__section">
        packetchat+ <span className="ch"><Icon.chev /></span>
      </div>
      <nav className="lr__nav" aria-label="packetchat+">
        {pluginsNav.map((item) => {
          const active = isActivePath(pathname, item.href);
          return (
            <Link key={item.id} href={item.href} aria-current={active ? "page" : undefined} className={active ? "on" : undefined}>
              {item.icon}
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="lr__list" />


      <UserFooter displayName={displayName} initials={initials} />
    </aside>
  );
}

function UserFooter({ displayName, initials }: { displayName: string; initials: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { user, logout } = useAuth();
  const toast = useToast();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const email = user?.email ?? "";

  useEffect(() => {
    if (!menuOpen) return;
    function handle(event: MouseEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", handle);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handle);
      document.removeEventListener("keydown", handleKey);
    };
  }, [menuOpen]);

  async function handleLogout() {
    try {
      await logout();
    } finally {
      window.location.href = "/login";
    }
  }

  function toggleTheme() {
    document.documentElement.classList.toggle("light");
    document.body.classList.toggle("light");
  }

  return (
    <div className="lr__footer" ref={wrapperRef}>
      <button
        type="button"
        className="lr__user"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
        title="Account menu"
      >
        <span className="av" aria-hidden="true">{initials}</span>
        <span className="nm">{displayName}</span>
        <Icon.chev />
      </button>
      <Link className="ib" href="/settings" title="Settings" aria-label="Settings">
        <Icon.gear />
      </Link>

      {menuOpen ? (
        <div className="user-pop" role="menu" aria-label="Account menu">
          <header className="user-pop__head">
            <span className="user-pop__av" aria-hidden="true">{initials}</span>
            <div className="user-pop__identity">
              <div className="user-pop__name">{displayName}</div>
              {email ? <div className="user-pop__email">{email}</div> : null}
            </div>
            <button
              className="ib"
              type="button"
              onClick={() => {
                setMenuOpen(false);
                void handleLogout();
              }}
              aria-label="Sign out"
              title="Sign out"
            >
              <Icon.logout />
            </button>
          </header>

          <div className="user-pop__grid">
            <button
              role="menuitem"
              type="button"
              className="user-pop__btn"
              onClick={() => {
                toast({ message: "Cloud sync is coming soon.", variant: "info" });
              }}
            >
              <span className="user-pop__icon user-pop__icon--cloud"><Icon.cloud /></span>
              Manage sync status
              <span className="user-pop__dot" aria-hidden="true" />
            </button>

            <div className="user-pop__row">
              <button
                role="menuitem"
                type="button"
                className="user-pop__btn"
                onClick={() => {
                  setMenuOpen(false);
                  setDialogOpen(true);
                }}
              >
                <span className="user-pop__icon user-pop__icon--lock"><Icon.lock /></span>
                Change password
              </button>
              <Link
                role="menuitem"
                href="/settings"
                className="user-pop__btn"
                onClick={() => setMenuOpen(false)}
              >
                <span className="user-pop__icon user-pop__icon--key"><Icon.key /></span>
                API Keys <span className="inline-preview">Preview</span>
              </Link>
            </div>

            <button
              role="menuitem"
              type="button"
              className="user-pop__btn"
              onClick={() => toast({ message: "Help & Information is coming soon.", variant: "info" })}
            >
              <span className="user-pop__icon user-pop__icon--info"><Icon.info /></span>
              Help &amp; Information
            </button>

            <a
              role="menuitem"
              href="https://github.com/packetloss404"
              target="_blank"
              rel="noreferrer"
              className="user-pop__btn"
              onClick={() => setMenuOpen(false)}
            >
              <span className="user-pop__icon user-pop__icon--gh"><Icon.github /></span>
              packetloss404 GitHub
            </a>
          </div>

          <footer className="user-pop__foot">
            <div className="user-pop__links">
              Fifty Eleven LLC © 2026 | <span>Contact <span className="inline-preview">Soon</span></span>
              <br />
              <span>Privacy <span className="inline-preview">Soon</span></span> | <span>Terms <span className="inline-preview">Soon</span></span> | <span>FAQs <span className="inline-preview">Soon</span></span> | <span>Docs <span className="inline-preview">Soon</span></span>
            </div>
            <div className="user-pop__toggles">
              <button className="user-pop__chip" type="button" aria-label="Region">US</button>
              <button className="user-pop__chip" type="button" onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme">
                <Icon.moon />
              </button>
            </div>
          </footer>
        </div>
      ) : null}

      {dialogOpen ? <ChangePasswordDialog onClose={() => setDialogOpen(false)} /> : null}
    </div>
  );
}

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    function onCancel(event: Event) {
      event.preventDefault();
      onClose();
    }
    dialog.addEventListener("cancel", onCancel);
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
    };
  }, [onClose]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!current || !next) {
      setError("Both current and new passwords are required.");
      return;
    }
    if (next !== confirm) {
      setError("New password and confirmation must match.");
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, next);
      toast({ message: "Password updated.", variant: "success" });
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialogRef} className="prompt-dialog" aria-label="Change password" onClose={onClose}>
      <form className="prompt-dialog__form" onSubmit={(event) => void submit(event)}>
        <header className="prompt-dialog__head">
          <h2>Change password</h2>
          <button className="ib" type="button" onClick={onClose} aria-label="Close" title="Close">
            <Icon.plus style={{ transform: "rotate(45deg)" }} />
          </button>
        </header>

        <label>
          Current password
          <input className="input" type="password" value={current} onChange={(event) => setCurrent(event.target.value)} required autoComplete="current-password" />
        </label>
        <label>
          New password
          <input className="input" type="password" value={next} onChange={(event) => setNext(event.target.value)} required minLength={8} autoComplete="new-password" />
        </label>
        <label>
          Confirm new password
          <input className="input" type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required minLength={8} autoComplete="new-password" />
        </label>

        {error ? <p className="error-state" role="alert">{error}</p> : null}

        <p className="muted" style={{ fontSize: 12 }}>
          Other sessions for this account will be signed out after a successful change.
        </p>

        <div className="prompt-dialog__actions">
          <button className="button button--ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="button button--primary" type="submit" disabled={busy}>{busy ? "Updating..." : "Change password"}</button>
        </div>
      </form>
    </dialog>
  );
}

function HeaderBar() {
  const pathname = usePathname() ?? "/";
  const title = resolveTitle(pathname);
  const { user, logout } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function handleLogout() {
    setBusy(true);
    try {
      await logout();
      window.location.href = "/login";
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="hdr" aria-label="Workspace header">
      <button
        className="hdr__model hdr__model--preview"
        type="button"
        title="Workspace switcher (preview)"
        onClick={() => toast({ message: "Workspace switching is coming soon.", variant: "info" })}
      >
        <span className="dot" aria-hidden="true" />
        {title}
        <span className="inline-preview">Preview</span>
        <span style={{ color: "var(--ink-3)" }}><Icon.chev /></span>
      </button>
      <button
        className="ib ib--preview"
        type="button"
        title="Copy link (preview)"
        aria-label="Copy link (preview)"
        onClick={() => toast({ message: "Shareable chat links are coming soon.", variant: "info" })}
      >
        <Icon.copy />
        <span className="preview-dot" aria-hidden="true">Preview</span>
      </button>
      <Link className="ib" href="/chat" title="New chat" aria-label="New chat">
        <Icon.plus />
      </Link>
      <div className="hdr__spacer" />
      {user ? (
        <button
          className="ib"
          type="button"
          title={busy ? "Signing out..." : `Sign out (${user.displayName || user.email})`}
          aria-label="Sign out"
          onClick={handleLogout}
          disabled={busy}
        >
          <Icon.logout />
        </button>
      ) : (
        <Link className="ib" href="/login" title="Sign in" aria-label="Sign in">
          <Icon.logout />
        </Link>
      )}
      <button
        className="ib ib--preview"
        type="button"
        title="More actions (preview)"
        aria-label="More actions (preview)"
        onClick={() => toast({ message: "More chat actions are coming soon.", variant: "info" })}
      >
        <Icon.dots />
        <span className="preview-dot" aria-hidden="true">Preview</span>
      </button>
    </header>
  );
}

type RightRailProps = {
  expanded: boolean;
  onToggle: () => void;
  activePanel: string | null;
  onPanelChange: (panel: string | null) => void;
};

function RightRail({ expanded, onToggle, activePanel, onPanelChange }: RightRailProps) {
  const router = useRouter();
  const item = (id: string, icon: React.ReactNode, label: string) => {
    const on = activePanel === id;
    return (
      <button
        className={`ib ${on ? "on" : ""}`}
        type="button"
        title={label}
        aria-label={label}
        aria-pressed={on}
        onClick={() => onPanelChange(on ? null : id)}
      >
        {icon}
        <span className="rr__label">{label}</span>
      </button>
    );
  };

  return (
    <aside className="rr" aria-label="Panels">
      <button
        className="ib"
        type="button"
        title="Prompts"
        aria-label="Prompts"
        onClick={() => router.push("/prompts")}
      >
        <Icon.text />
        <span className="rr__label">Prompts</span>
      </button>
      {item("memories", <Icon.memories />, "Memories")}
      {item("parameters", <Icon.params />, "Parameters")}
      {item("attach", <Icon.attach />, "Attach Files")}
      {item("bookmarks", <Icon.bookmark />, "Bookmarks")}
      {item("mcp", <Icon.mcp />, "MCP Drafts")}
      <div style={{ flex: 1 }} />
      <button
        className="ib"
        data-hidepanel
        type="button"
        title={expanded ? "Hide Panel" : "Show Panel"}
        aria-label={expanded ? "Hide Panel" : "Show Panel"}
        onClick={onToggle}
      >
        {expanded ? <Icon.hidePanel /> : <Icon.caret />}
        <span className="rr__label">Hide Panel</span>
      </button>
    </aside>
  );
}

const PANEL_TITLES: Record<string, string> = {
  memories: "Memories",
  parameters: "Parameters",
  attach: "Attach Files",
  bookmarks: "Bookmarks",
  mcp: "MCP Drafts"
};

const CloseGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <path d="M3 3l8 8M11 3l-8 8" />
  </svg>
);

const UploadGlyph = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 16V4" />
    <path d="M7 9l5-5 5 5" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </svg>
);

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* noop */
  }
}

function MemoriesPanel() {
  const [items, setItems] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const toast = useToast();

  useEffect(() => {
    const stored = readJSON<string[] | null>("packetchat.memories", null);
    if (Array.isArray(stored)) setItems(stored);
  }, []);

  function save() {
    const value = draft.trim();
    if (!value) return;
    const next = [...items, value];
    setItems(next);
    writeJSON("packetchat.memories", next);
    setDraft("");
    toast({ message: "Memory saved.", variant: "success" });
  }

  function remove(index: number) {
    const next = items.filter((_, i) => i !== index);
    setItems(next);
    writeJSON("packetchat.memories", next);
  }

  return (
    <div className="rrd__body">
      <ul className="rrd__list">
        {items.length === 0 ? <li className="rrd__empty">No memories yet.</li> : null}
        {items.map((memory, index) => (
          <li key={`${memory}-${index}`} className="rrd__row">
            <span className="rrd__row-text">{memory}</span>
            <button className="ib rrd__row-x" type="button" aria-label="Remove memory" onClick={() => remove(index)}>
              <CloseGlyph />
            </button>
          </li>
        ))}
      </ul>
      <label className="rrd__field">
        <span className="rrd__label">Add memory</span>
        <textarea
          className="input rrd__textarea"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Anything PacketChat should remember about you..."
          rows={3}
        />
      </label>
      <div className="rrd__actions">
        <button className="button button--primary" type="button" onClick={save} disabled={!draft.trim()}>
          Save
        </button>
      </div>
    </div>
  );
}

type Parameters = {
  temperature: number;
  maxTokens: number;
  topP: number;
  systemPrompt: string;
};

const DEFAULT_PARAMETERS: Parameters = {
  temperature: 0.7,
  maxTokens: 1024,
  topP: 1,
  systemPrompt: ""
};

function ParametersPanel() {
  const [params, setParams] = useState<Parameters>(DEFAULT_PARAMETERS);
  const toast = useToast();

  useEffect(() => {
    const stored = readJSON<Partial<Parameters> | null>("packetchat.parameters", null);
    if (stored && typeof stored === "object") {
      setParams({ ...DEFAULT_PARAMETERS, ...stored });
    }
  }, []);

  function update<K extends keyof Parameters>(key: K, value: Parameters[K]) {
    const next = { ...params, [key]: value };
    setParams(next);
    writeJSON("packetchat.parameters", next);
  }

  function reset() {
    setParams(DEFAULT_PARAMETERS);
    writeJSON("packetchat.parameters", DEFAULT_PARAMETERS);
    toast({ message: "Parameters reset to defaults.", variant: "info" });
  }

  return (
    <div className="rrd__body">
      <label className="rrd__field">
        <span className="rrd__label">
          Temperature <span className="rrd__value">{params.temperature.toFixed(2)}</span>
        </span>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={params.temperature}
          onChange={(event) => update("temperature", Number(event.target.value))}
          className="rrd__slider"
        />
      </label>
      <label className="rrd__field">
        <span className="rrd__label">Max tokens</span>
        <input
          type="number"
          min={1}
          max={32000}
          step={1}
          className="input"
          value={params.maxTokens}
          onChange={(event) => update("maxTokens", Number(event.target.value) || 0)}
        />
      </label>
      <label className="rrd__field">
        <span className="rrd__label">
          Top-P <span className="rrd__value">{params.topP.toFixed(2)}</span>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={params.topP}
          onChange={(event) => update("topP", Number(event.target.value))}
          className="rrd__slider"
        />
      </label>
      <label className="rrd__field">
        <span className="rrd__label">System prompt</span>
        <textarea
          className="input rrd__textarea"
          rows={5}
          placeholder="Optional system instructions..."
          value={params.systemPrompt}
          onChange={(event) => update("systemPrompt", event.target.value)}
        />
      </label>
      <div className="rrd__actions">
        <button className="button button--ghost" type="button" onClick={reset}>
          Reset
        </button>
      </div>
    </div>
  );
}

type AttachedFile = { name: string; size: number };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function AttachFilesPanel() {
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const toast = useToast();

  function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const next = [...files];
    for (const file of Array.from(list)) {
      next.push({ name: file.name, size: file.size });
    }
    setFiles(next);
    toast({ message: "File attachments are coming soon when you hit Send with files.", variant: "info" });
  }

  function remove(index: number) {
    setFiles(files.filter((_, i) => i !== index));
  }

  return (
    <div className="rrd__body">
      <div
        className={`rrd__drop ${dragging ? "rrd__drop--on" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          addFiles(event.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
      >
        <UploadGlyph />
        <div className="rrd__drop-title">Drop files or click to browse</div>
        <div className="rrd__drop-sub">Files stay local until upload ships.</div>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>
      <ul className="rrd__list">
        {files.length === 0 ? <li className="rrd__empty">No files picked.</li> : null}
        {files.map((file, index) => (
          <li key={`${file.name}-${index}`} className="rrd__row">
            <span className="rrd__row-text">
              <strong className="rrd__row-name">{file.name}</strong>
              <span className="rrd__row-meta">{formatBytes(file.size)}</span>
            </span>
            <button className="ib rrd__row-x" type="button" aria-label="Remove file" onClick={() => remove(index)}>
              <CloseGlyph />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BookmarksPanel() {
  const [ids, setIds] = useState<string[]>([]);

  useEffect(() => {
    const stored = readJSON<string[] | null>("packetchat.chat.bookmarks", null);
    if (Array.isArray(stored)) setIds(stored);
  }, []);

  function clearAll() {
    setIds([]);
    writeJSON("packetchat.chat.bookmarks", []);
  }

  if (ids.length === 0) {
    return (
      <div className="rrd__body">
        <p className="rrd__empty">No bookmarks yet — bookmark assistant messages from chat.</p>
      </div>
    );
  }

  return (
    <div className="rrd__body">
      <ul className="rrd__list">
        {ids.map((id) => (
          <li key={id} className="rrd__row rrd__row--muted">
            <span className="rrd__row-text">
              <span className="rrd__row-meta">message</span>
              <code className="rrd__row-name">{id}</code>
            </span>
          </li>
        ))}
      </ul>
      <div className="rrd__actions">
        <button className="button button--ghost" type="button" onClick={clearAll}>
          Clear all
        </button>
      </div>
    </div>
  );
}

type McpServer = { id: string; name: string; description: string };
const MCP_SERVERS: McpServer[] = [
  { id: "postgres", name: "Postgres MCP", description: "Local draft only; runtime MCP connections are not wired yet." },
  { id: "grafana", name: "Grafana MCP", description: "Local draft only; runtime MCP connections are not wired yet." }
];

function McpPanel() {
  const [connected, setConnected] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const stored = readJSON<Record<string, boolean> | null>("packetchat.mcp.connections", null);
    if (stored && typeof stored === "object") setConnected(stored);
  }, []);

  function toggle(id: string) {
    const next = { ...connected, [id]: !connected[id] };
    setConnected(next);
    writeJSON("packetchat.mcp.connections", next);
  }

  return (
    <div className="rrd__body">
      <ul className="rrd__list">
        {MCP_SERVERS.map((server) => {
          const on = !!connected[server.id];
          return (
            <li key={server.id} className="rrd__mcp">
              <div className="rrd__mcp-info">
                <div className="rrd__row-name">{server.name}</div>
                <div className="rrd__row-meta">{server.description}</div>
              </div>
              <button
                className={`button ${on ? "button--ghost" : "button--primary"}`}
                type="button"
                onClick={() => toggle(server.id)}
              >
                {on ? "Draft saved" : "Save draft"}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PanelContent({ panel }: { panel: string }) {
  switch (panel) {
    case "memories":
      return <MemoriesPanel />;
    case "parameters":
      return <ParametersPanel />;
    case "attach":
      return <AttachFilesPanel />;
    case "bookmarks":
      return <BookmarksPanel />;
    case "mcp":
      return <McpPanel />;
    default:
      return null;
  }
}

type RightDrawerProps = {
  panel: string;
  onClose: () => void;
};

function RightDrawer({ panel, onClose }: RightDrawerProps) {
  const title = PANEL_TITLES[panel] ?? "Panel";
  return (
    <aside className="rrd" aria-label={`${title} panel`}>
      <header className="rrd__head">
        <h3 className="rrd__title">{title}</h3>
        <button className="ib" type="button" onClick={onClose} aria-label="Close panel" title="Close">
          <CloseGlyph />
        </button>
      </header>
      <PanelContent panel={panel} />
    </aside>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [rrExpanded, setRrExpanded] = useState(false);
  const [rrPanel, setRrPanel] = useState<string | null>(null);
  const drawerOpen = rrPanel !== null && PANEL_TITLES[rrPanel] !== undefined;

  useEffect(() => {
    if (!drawerOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setRrPanel(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  function handleHidePanelToggle() {
    setRrExpanded((v) => !v);
    setRrPanel(null);
  }

  return (
    <div
      className="app"
      data-variant="clone"
      data-rightrail="on"
      data-rrexpanded={rrExpanded ? "on" : "off"}
      data-rrpanel={drawerOpen ? "open" : "closed"}
    >
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <LeftRail />
      <main className="main" id="main-content" tabIndex={-1}>
        <HeaderBar />
        {children}
      </main>
      {drawerOpen && rrPanel ? <RightDrawer panel={rrPanel} onClose={() => setRrPanel(null)} /> : null}
      <RightRail
        expanded={rrExpanded}
        onToggle={handleHidePanelToggle}
        activePanel={rrPanel}
        onPanelChange={setRrPanel}
      />
    </div>
  );
}

export function AppShellHeader() {
  return <HeaderBar />;
}
