"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { apiClient } from "../lib/api-client";
import { getAccessToken } from "../lib/auth-client";
import { useAuth } from "./auth-provider";
import { Icon } from "./icons";

type NavItem = {
  id: string;
  label: string;
  href: string;
  icon: React.ReactNode;
  badge?: string;
};

const primaryNav: NavItem[] = [
  { id: "agents", label: "Agents", href: "/agents", icon: <Icon.grid /> },
  { id: "providers", label: "Providers", href: "/providers", icon: <Icon.key /> },
  { id: "projects", label: "Projects", href: "/projects", icon: <Icon.folder /> },
  { id: "prompts", label: "Prompts", href: "/prompts", icon: <Icon.text /> },
  { id: "knowledge", label: "Knowledge", href: "/knowledge", icon: <Icon.layers /> },
  { id: "users", label: "Users", href: "/admin/users", icon: <Icon.users /> },
  { id: "usage", label: "Usage", href: "/admin/usage", icon: <Icon.mixer /> }
];

const pluginsNav: NavItem[] = [
  { id: "marketplace", label: "Agent Marketplace", href: "/plugins/marketplace", icon: <Icon.layers /> }
];

const routeTitles: Array<{ match: (p: string) => boolean; title: string }> = [
  { match: (p) => p.startsWith("/plugins/marketplace"), title: "Agent Marketplace" },
  { match: (p) => p.startsWith("/plugins"), title: "Plugins" },
  { match: (p) => p.startsWith("/agents"), title: "Agents" },
  { match: (p) => p.startsWith("/providers"), title: "Providers" },
  { match: (p) => p.startsWith("/projects"), title: "Projects" },
  { match: (p) => p.startsWith("/prompts"), title: "Prompt library" },
  { match: (p) => p.startsWith("/knowledge"), title: "Knowledge" },
  { match: (p) => p.startsWith("/admin/users"), title: "Users" },
  { match: (p) => p.startsWith("/admin/usage"), title: "Usage" },
  { match: (p) => p.startsWith("/login"), title: "Sign in" },
  { match: (p) => p.startsWith("/chat"), title: "claude-sonnet-4-5" }
];

const threadGroups: Array<{ label: string; items: Array<{ id: string; title: string; tint: string }> }> = [
  {
    label: "Previous 30 days",
    items: [{ id: "c1", title: "Rotate pilot DB secrets", tint: "#d97757" }]
  },
  {
    label: "February",
    items: [
      { id: "c2", title: "Draft runbook: restore drill", tint: "#d97757" },
      { id: "c3", title: "Compare sonar-large vs sonar-small", tint: "#1fb8cd" },
      { id: "c4", title: "Azure deployment naming audit", tint: "#4b8ad6" },
      { id: "c5", title: "Seed script idempotency", tint: "#10a37f" }
    ]
  },
  {
    label: "January",
    items: [{ id: "c6", title: "Knowledge chunker review", tint: "#d97757" }]
  }
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

  useEffect(() => {
    if (!user) return;
    if (typeof window === "undefined") return;
    if (!getAccessToken()) return;

    let cancelled = false;

    const apply = (id: string, value: string) => {
      if (cancelled) return;
      setCounts((prev) => (prev[id] === value ? prev : { ...prev, [id]: value }));
    };

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

    apiClient.admin.users
      .list()
      .then((res) => apply("users", String(res.users.length)))
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [user]);

  return (
    <aside className="lr" aria-label="Primary navigation">
      <div className="lr__top">
        <button className="ib" type="button" title="Collapse sidebar" aria-label="Collapse sidebar">
          <Icon.sidebar />
        </button>
        <div className="brand">
          packet<span>chat</span>
        </div>
        <button className="ib" type="button" title="Bookmarks" aria-label="Bookmarks">
          <Icon.bookmark />
        </button>
        <Link className="ib" href="/chat" title="New chat" aria-label="New chat">
          <Icon.edit />
        </Link>
      </div>

      <label className="lr__search" aria-label="Search messages">
        <Icon.search />
        <input placeholder="Search messages" />
      </label>

      <nav className="lr__nav" aria-label="Primary sections">
        {primaryNav.map((item) => {
          const active = isActivePath(pathname, item.href);
          const badge = counts[item.id] ?? item.badge;
          return (
            <Link key={item.id} href={item.href} aria-current={active ? "page" : undefined} className={active ? "on" : undefined}>
              {item.icon}
              <span>{item.label}</span>
              {badge ? <span className="badge">{badge}</span> : null}
            </Link>
          );
        })}
      </nav>

      <div className="lr__section">
        Plugins <span className="ch"><Icon.chev /></span>
      </div>
      <nav className="lr__nav" aria-label="Plugins">
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

      <div className="lr__section">
        Chats <span className="ch"><Icon.chev /></span>
      </div>
      <div className="lr__list">
        {threadGroups.map((group) => (
          <div className="lr__group" key={group.label}>
            <h4>{group.label}</h4>
            {group.items.map((thread) => (
              <Link
                key={thread.id}
                href="/chat"
                className="lr__thread"
                title={thread.title}
              >
                <span className="ico" aria-hidden="true">
                  <span style={{ width: 12, height: 12, borderRadius: 3, background: thread.tint, display: "inline-block" }} />
                </span>
                <span className="t">{thread.title}</span>
              </Link>
            ))}
          </div>
        ))}
      </div>

      <div className="lr__footer">
        <div className="av" aria-hidden="true">{initials}</div>
        <div className="nm">{displayName}</div>
        <button className="ib" type="button" title="Account menu" aria-label="Account menu">
          <Icon.dots />
        </button>
      </div>
    </aside>
  );
}

function HeaderBar() {
  const pathname = usePathname() ?? "/";
  const title = resolveTitle(pathname);
  const { user, logout } = useAuth();
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
      <button className="hdr__model" type="button" title="Model / workspace switcher">
        <span className="dot" aria-hidden="true" />
        {title}
        <span style={{ color: "var(--ink-3)" }}><Icon.chev /></span>
      </button>
      <button className="ib" type="button" title="Copy link" aria-label="Copy link">
        <Icon.copy />
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
      <button className="ib" type="button" title="More" aria-label="More">
        <Icon.dots />
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
      {item("mcp", <Icon.mcp />, "MCP Settings")}
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

export function AppShell({ children }: { children: React.ReactNode }) {
  const [rrExpanded, setRrExpanded] = useState(false);
  const [rrPanel, setRrPanel] = useState<string | null>(null);

  return (
    <div className="app" data-variant="clone" data-rightrail="on" data-rrexpanded={rrExpanded ? "on" : "off"}>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <LeftRail />
      <main className="main" id="main-content" tabIndex={-1}>
        <HeaderBar />
        {children}
      </main>
      <RightRail
        expanded={rrExpanded}
        onToggle={() => setRrExpanded((v) => !v)}
        activePanel={rrPanel}
        onPanelChange={setRrPanel}
      />
    </div>
  );
}

export function AppShellHeader() {
  return <HeaderBar />;
}
