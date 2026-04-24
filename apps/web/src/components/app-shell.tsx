"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useAuth } from "./auth-provider";

type SessionState = {
  label: string;
  detail: string;
  signedIn: boolean;
};

type NavSection = "workspace" | "library" | "admin";

export type NavItem = {
  label: string;
  href: string;
  description: string;
  section: NavSection;
};

const navSections: Array<{ id: NavSection; label: string }> = [
  { id: "workspace", label: "Work" },
  { id: "library", label: "Library" },
  { id: "admin", label: "Admin" }
];

const navItems: NavItem[] = [
  { label: "Home", href: "/", description: "Instance overview", section: "workspace" },
  { label: "Chat", href: "/chat", description: "Conversations and model routing", section: "workspace" },
  { label: "Projects", href: "/projects", description: "Workspace instructions", section: "workspace" },
  { label: "Agents", href: "/agents", description: "Build and test assistants", section: "workspace" },
  { label: "Prompts", href: "/prompts", description: "Reusable templates", section: "library" },
  { label: "Knowledge", href: "/knowledge", description: "Documents and retrieval", section: "library" },
  { label: "Providers", href: "/providers", description: "Keys, models, BYOK", section: "admin" },
  { label: "Usage", href: "/admin/usage", description: "Spend and token traces", section: "admin" },
  { label: "Users", href: "/admin/users", description: "Accounts and access", section: "admin" }
];

function isActivePath(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function SidebarNav({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="nav" aria-label="Primary navigation">
      {navSections.map((section) => {
        const sectionItems = items.filter((item) => item.section === section.id);
        return (
          <div className="nav__section" key={section.id}>
            <div className="nav__section-title">{section.label}</div>
            <div className="nav__section-items">
              {sectionItems.map((item) => {
                const active = isActivePath(pathname, item.href);
                return (
                  <Link className="nav__item" href={item.href} key={item.href} aria-current={active ? "page" : undefined} onClick={onNavigate}>
                    <span className="nav__item-label">{item.label}</span>
                    <span className="nav__item-description">{item.description}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <div className="mobile-bar">
        <Link className="brand" href="/" onClick={() => setNavOpen(false)}>PacketChat</Link>
        <button className="button button--ghost mobile-nav-toggle" type="button" aria-expanded={navOpen} aria-controls="primary-sidebar" onClick={() => setNavOpen((open) => !open)}>
          Menu
        </button>
      </div>
      <aside className={`sidebar ${navOpen ? "sidebar--open" : ""}`} id="primary-sidebar">
        <Link className="brand" href="/" onClick={() => setNavOpen(false)}>
          <span>PacketChat</span>
          <span className="brand__mark" aria-hidden="true">PC</span>
        </Link>
        <p className="muted sidebar__intro">Private AI routing, chat, knowledge, and agents for a small self-hosted instance.</p>
        <SidebarNav items={navItems} onNavigate={() => setNavOpen(false)} />
        <div className="sidebar__status" aria-label="Instance status">
          <span className="status-dot" aria-hidden="true" />
          <span>Self-hosted instance</span>
        </div>
      </aside>
      <div className="content-shell">
        <AppShellHeader />
        <main className="main" id="main-content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}

export function AppShellHeader() {
  const { status, user, logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const session: SessionState = user
    ? { label: user.displayName || user.email, detail: user.role ? `${user.role} account` : "Signed in", signedIn: true }
    : status === "loading"
      ? { label: "Checking session", detail: "Loading", signedIn: false }
      : { label: "Not signed in", detail: "Login required", signedIn: false };

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
    <header className="topbar" aria-label="Account and session">
      <div>
        <div className="topbar__label">Packet route</div>
        <div className="topbar__user">{session.label}</div>
        <div className="muted topbar__detail">{session.detail}</div>
      </div>
      <div className="topbar__actions">
        <Link className="button button--ghost" href="/login">Login</Link>
        <button className="button" type="button" onClick={handleLogout} disabled={busy || !session.signedIn} aria-label="Sign out of PacketChat">
          {busy ? "Signing out..." : "Logout"}
        </button>
      </div>
    </header>
  );
}
