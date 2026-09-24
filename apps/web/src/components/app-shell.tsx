"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { apiClient, type Conversation, type ConversationExportFormat, type ConversationShare } from "../lib/api-client";
import { changePassword, getAccessToken } from "../lib/auth-client";
import { requestModelPicker, setChatHeader, useChatHeader } from "../lib/chat-header-store";
import { useAuth } from "./auth-provider";
import { Icon } from "./icons";
import { ConfirmButton, useToast } from "./ui";

// -----------------------------------------------------------------------------
// Theme store — one persisted implementation shared by the account popover and
// Settings → Appearance. It toggles `.light` on <html> only and stores the
// choice under `packetchat.settings.appearance.theme`. The pre-hydration script
// in app/layout.tsx reads the same key before paint.
// -----------------------------------------------------------------------------

export const THEME_STORAGE_KEY = "packetchat.settings.appearance.theme";

export type ThemeMode = "dark" | "light";

const themeListeners = new Set<() => void>();

function readStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(mode: ThemeMode) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("light", mode === "light");
}

export function getThemeSnapshot(): ThemeMode {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

export function setTheme(mode: ThemeMode) {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      /* Ignore storage failures; the class still applies for this session. */
    }
  }
  applyTheme(mode);
  for (const listener of themeListeners) listener();
}

export function subscribeTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  function onStorage(event: StorageEvent) {
    if (event.key !== THEME_STORAGE_KEY) return;
    applyTheme(readStoredTheme());
    listener();
  }
  window.addEventListener("storage", onStorage);
  return () => {
    themeListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useTheme(): ThemeMode {
  return useSyncExternalStore(subscribeTheme, getThemeSnapshot, () => "dark");
}

type NavItem = {
  id: string;
  label: string;
  href: string;
  icon: React.ReactNode;
  badge?: string;
};

const mainNav: NavItem[] = [
  { id: "chats", label: "Chats", href: "/chat", icon: <Icon.chat /> },
  { id: "agents", label: "Agents", href: "/agents", icon: <Icon.grid /> },
  { id: "prompts", label: "Prompts", href: "/prompts", icon: <Icon.text /> },
  { id: "knowledge", label: "Knowledge", href: "/knowledge", icon: <Icon.layers /> },
  { id: "providers", label: "Models", href: "/providers", icon: <Icon.key /> },
  { id: "projects", label: "Projects", href: "/projects", icon: <Icon.folder /> },
  { id: "approvals", label: "Approvals", href: "/approvals", icon: <Icon.bell /> }
];

const adminNav: NavItem[] = [
  { id: "users", label: "Users", href: "/admin/users", icon: <Icon.users /> },
  { id: "adminProviders", label: "Providers", href: "/admin/providers", icon: <Icon.key /> },
  { id: "usage", label: "Usage", href: "/admin/usage", icon: <Icon.mixer /> },
  { id: "audit", label: "Audit", href: "/admin/audit", icon: <Icon.lock /> },
  { id: "operations", label: "Operations", href: "/admin/operations", icon: <Icon.database /> }
];

const routeTitles: Array<{ match: (p: string) => boolean; title: string }> = [
  { match: (p) => p.startsWith("/approvals"), title: "Approvals" },
  { match: (p) => p.startsWith("/agents"), title: "Agents" },
  { match: (p) => p.startsWith("/providers"), title: "Models" },
  { match: (p) => p.startsWith("/projects"), title: "Projects" },
  { match: (p) => p.startsWith("/prompts"), title: "Prompts" },
  { match: (p) => p.startsWith("/knowledge"), title: "Knowledge" },
  { match: (p) => p.startsWith("/admin/providers"), title: "Providers & keys" },
  { match: (p) => p.startsWith("/admin/users"), title: "Users" },
  { match: (p) => p.startsWith("/admin/usage"), title: "Usage" },
  { match: (p) => p.startsWith("/admin/audit"), title: "Audit" },
  { match: (p) => p.startsWith("/admin/operations"), title: "Operations" },
  { match: (p) => p.startsWith("/login"), title: "Sign in" },
  { match: (p) => p.startsWith("/settings"), title: "Settings" }
];

function isActivePath(pathname: string, href: string) {
  if (href === "/") return pathname === href;
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

type ChatItem = { id: string; title: string };

function toChatItems(conversations: Conversation[]): ChatItem[] {
  return conversations.map((conversation) => ({
    id: conversation.id,
    title: conversation.title || "Untitled chat"
  }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = /filename="?([^";]+)"?/i.exec(header);
  return match ? match[1] : null;
}

function exportFilename(title: string, format: ConversationExportFormat): string {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${slug || "conversation"}.${format}`;
}

// Revoking an object URL immediately after `anchor.click()` (or on a 0ms timer)
// can abort slow downloads in some browsers. Give the transfer a grace period,
// and revoke early if the window regains focus before then.
function revokeObjectUrlWhenSafe(url: string) {
  let timer: number | undefined;
  let done = false;
  const revoke = () => {
    if (done) return;
    done = true;
    if (timer !== undefined) window.clearTimeout(timer);
    window.removeEventListener("focus", revoke);
    URL.revokeObjectURL(url);
  };
  timer = window.setTimeout(revoke, 1000);
  window.addEventListener("focus", revoke);
}

const CONVERSATIONS_CHANGED_EVENT = "packetchat:conversations-changed";

type LeftRailProps = {
  onMobileClose?: () => void;
  onNavigate?: () => void;
};

function LeftRail({ onMobileClose, onNavigate }: LeftRailProps) {
  const pathname = usePathname() ?? "/";
  const { user } = useAuth();
  const displayName = user?.displayName || user?.email?.split("@")[0] || "Guest";
  const initials = useMemo(() => userInitials(displayName), [displayName]);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [recent, setRecent] = useState<ChatItem[]>([]);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<ChatItem[]>([]);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [shareFor, setShareFor] = useState<ChatItem | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuListRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const toast = useToast();
  const searching = search.trim().length > 0;
  const visible = searching ? results : recent;
  const isAdmin = user?.role === "admin";

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
      .then((res) => {
        const list = res.conversations ?? [];
        apply("chats", String(list.length));
        setRecent(toChatItems(list.slice(0, 8)));
      })
      .catch(() => undefined);

    apiClient.agents
      .list()
      .then((res) => apply("agents", String(res.agents.length)))
      .catch(() => undefined);

    apiClient.approvals
      .list()
      .then((res) => apply("approvals", res.stats.pending > 0 ? String(res.stats.pending) : ""))
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

  const refreshRecent = useCallback(async () => {
    try {
      const res = await apiClient.conversations.list();
      const list = res.conversations ?? [];
      setCounts((prev) => (prev.chats === String(list.length) ? prev : { ...prev, chats: String(list.length) }));
      setRecent(toChatItems(list.slice(0, 8)));
    } catch {
      /* Ignore refresh failures; the next load will reconcile. */
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    if (!getAccessToken()) return;
    const term = search.trim();
    if (!term) {
      setResults([]);
      return;
    }

    let cancelled = false;
    const handle = window.setTimeout(() => {
      apiClient.conversations
        .list({ search: term })
        .then((res) => {
          if (!cancelled) setResults(toChatItems(res.conversations ?? []));
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [search, user]);

  useEffect(() => {
    if (!user) return;
    if (typeof window === "undefined") return;
    function handleConversationsChanged() {
      void refreshRecent();
    }
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, handleConversationsChanged);
    return () => {
      window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, handleConversationsChanged);
    };
  }, [user, refreshRecent]);

  useEffect(() => {
    if (!menuFor) return;
    const trigger = menuTriggerRef.current;
    const list = menuListRef.current;
    list?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();

    function handlePointer(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuFor(null);
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuFor(null);
        setEditingId(null);
      }
    }
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
      // Restore focus only when it was lost to <body> as the menu unmounted.
      // If focus already moved to another control (e.g. the rename input) the
      // action handler owns it, so leave it alone.
      const active = document.activeElement;
      const focusLost = !active || active === document.body;
      if (focusLost && trigger && document.contains(trigger)) {
        trigger.focus();
      }
    };
  }, [menuFor]);

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])"));
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next = 0;
    if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
    else if (event.key === "ArrowUp") next = current <= 0 ? items.length - 1 : current - 1;
    else if (event.key === "End") next = items.length - 1;
    items[next]?.focus();
  }

  function updateLocalTitle(id: string, title: string) {
    const apply = (items: ChatItem[]) => items.map((item) => (item.id === id ? { ...item, title } : item));
    setRecent(apply);
    setResults(apply);
  }

  function removeLocal(id: string) {
    const filter = (items: ChatItem[]) => items.filter((item) => item.id !== id);
    setRecent(filter);
    setResults(filter);
  }

  function startRename(item: ChatItem) {
    setMenuFor(null);
    setEditingId(item.id);
    setEditingTitle(item.title);
  }

  async function commitRename(id: string) {
    const title = editingTitle.trim();
    setEditingId(null);
    const current = recent.find((item) => item.id === id) ?? results.find((item) => item.id === id);
    if (!title || title === current?.title) return;

    const snapshotRecent = recent;
    const snapshotResults = results;
    updateLocalTitle(id, title);
    try {
      await apiClient.conversations.update(id, { title });
      toast({ message: "Chat renamed.", variant: "success" });
    } catch (error) {
      setRecent(snapshotRecent);
      setResults(snapshotResults);
      toast({ message: errorMessage(error), variant: "error" });
    }
  }

  async function archiveConversation(item: ChatItem) {
    setMenuFor(null);
    try {
      await apiClient.conversations.update(item.id, { archived: true });
      removeLocal(item.id);
      await refreshRecent();
      toast({ message: "Chat archived.", variant: "success" });
    } catch (error) {
      toast({ message: errorMessage(error), variant: "error" });
    }
  }

  async function deleteConversation(item: ChatItem) {
    try {
      await apiClient.conversations.delete(item.id);
      removeLocal(item.id);
      await refreshRecent();
      toast({ message: "Chat deleted.", variant: "success" });
    } catch (error) {
      toast({ message: errorMessage(error), variant: "error" });
    } finally {
      setMenuFor(null);
    }
  }

  async function exportConversation(item: ChatItem, format: ConversationExportFormat) {
    setMenuFor(null);
    try {
      const response = await apiClient.conversations.export(item.id, format);
      if (!response.ok) throw new Error(`Export failed (${response.status})`);
      const blob = await response.blob();
      const filename = filenameFromDisposition(response.headers.get("content-disposition")) ?? exportFilename(item.title, format);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      revokeObjectUrlWhenSafe(url);
      toast({ message: "Chat exported.", variant: "success" });
    } catch (error) {
      toast({ message: errorMessage(error), variant: "error" });
    }
  }

  return (
    <aside
      className="lr"
      id="primary-navigation"
      aria-label="Primary navigation"
    >
      <div className="lr__top">
        <div className="brand">
          Packet<span>Chat</span>
        </div>
        <Link className="ib" href="/chat" title="New chat" aria-label="New chat" onClick={onNavigate}>
          <Icon.edit />
        </Link>
        {onMobileClose ? (
          <button
            className="ib lr__mobile-close"
            type="button"
            title="Close navigation"
            aria-label="Close navigation"
            onClick={onMobileClose}
            data-mobile-nav-close
          >
            <Icon.plus style={{ transform: "rotate(45deg)" }} />
          </button>
        ) : null}
      </div>

      <div className="lr__list">
        <nav className="lr__nav" aria-label="Primary sections">
          {mainNav.map((item) => {
            const active = isActivePath(pathname, item.href);
            const badge = counts[item.id] ?? item.badge;
            const link = (
              <Link key={item.id} href={item.href} aria-current={active ? "page" : undefined} className={active ? "on" : undefined} onClick={onNavigate}>
                {item.icon}
                <span>{item.label}</span>
                {badge ? <span className="badge">{badge}</span> : null}
              </Link>
            );

            if (item.id !== "chats") return link;

            return (
              <div className="lr__nav-group" key={item.id}>
                {link}
                <div className="lr__search">
                  <Icon.search />
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search chats"
                    aria-label="Search conversations"
                  />
                  {search ? (
                    <button className="ib" type="button" title="Clear search" aria-label="Clear search" onClick={() => setSearch("")}>
                      <Icon.plus style={{ transform: "rotate(45deg)" }} />
                    </button>
                  ) : null}
                </div>
                <div className="lr__nav-children" aria-label="Recent chats">
                  <div className="lr__group">
                    {visible.length === 0 ? (
                      <p className="muted" style={{ margin: "4px 12px 8px", fontSize: 12 }}>
                        {searching ? "No chats match your search." : "Chats appear here after you start them."}
                      </p>
                    ) : (
                      visible.map((conversation, index) => {
                        if (editingId === conversation.id) {
                          return (
                            <form
                              key={conversation.id}
                              className="lr__thread"
                              onSubmit={(event) => {
                                event.preventDefault();
                                void commitRename(conversation.id);
                              }}
                            >
                              <span className="ico" aria-hidden="true"><Icon.chat /></span>
                              <input
                                className="input"
                                value={editingTitle}
                                onChange={(event) => setEditingTitle(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Escape") {
                                    event.preventDefault();
                                    setEditingId(null);
                                  }
                                }}
                                aria-label="Chat title"
                                autoFocus
                                style={{ flex: 1, minWidth: 0, height: 28, padding: "4px 8px", fontSize: 13 }}
                              />
                              <button className="button button--primary" type="submit" style={{ minHeight: 28, padding: "4px 10px", fontSize: 12 }}>
                                Save
                              </button>
                            </form>
                          );
                        }

                        const open = menuFor === conversation.id;
                        const openUp = index >= visible.length - 2;
                        return (
                          <div key={conversation.id} ref={open ? menuRef : undefined} style={{ position: "relative" }}>
                            <Link
                              className="lr__thread"
                              href={`/chat?conversation=${encodeURIComponent(conversation.id)}`}
                              title={conversation.title}
                              onClick={onNavigate}
                              style={{ paddingRight: 36 }}
                            >
                              <span className="ico" aria-hidden="true"><Icon.chat /></span>
                              <span className="t">{conversation.title}</span>
                            </Link>
                            <button
                              className="ib"
                              type="button"
                              ref={open ? menuTriggerRef : undefined}
                              title="Chat actions"
                              aria-label={`Chat actions for ${conversation.title}`}
                              aria-haspopup="menu"
                              aria-expanded={open}
                              onClick={(event) => {
                                menuTriggerRef.current = event.currentTarget;
                                setEditingId(null);
                                setMenuFor(open ? null : conversation.id);
                              }}
                              style={{ position: "absolute", top: "50%", right: 2, transform: "translateY(-50%)" }}
                            >
                              <Icon.dots />
                            </button>
                            {open ? (
                              <div
                                ref={menuListRef}
                                className="user-pop"
                                role="menu"
                                aria-label={`Actions for ${conversation.title}`}
                                onKeyDown={handleMenuKeyDown}
                                style={{
                                  bottom: openUp ? "calc(100% + 4px)" : "auto",
                                  top: openUp ? "auto" : "calc(100% - 2px)",
                                  left: "auto",
                                  right: 0,
                                  width: 220,
                                  padding: 6,
                                  gap: 4,
                                  zIndex: 60
                                }}
                              >
                                <button role="menuitem" className="user-pop__btn" type="button" onClick={() => startRename(conversation)}>
                                  <Icon.edit /> Rename
                                </button>
                                <button role="menuitem" className="user-pop__btn" type="button" onClick={() => void archiveConversation(conversation)}>
                                  <Icon.tag /> Archive
                                </button>
                                <button role="menuitem" className="user-pop__btn" type="button" onClick={() => void exportConversation(conversation, "md")}>
                                  <Icon.text /> Export Markdown
                                </button>
                                <button role="menuitem" className="user-pop__btn" type="button" onClick={() => void exportConversation(conversation, "json")}>
                                  <Icon.text /> Export JSON
                                </button>
                                <button role="menuitem" className="user-pop__btn" type="button" onClick={() => void exportConversation(conversation, "txt")}>
                                  <Icon.text /> Export as text (.txt)
                                </button>
                                <button
                                  role="menuitem"
                                  className="user-pop__btn"
                                  type="button"
                                  onClick={() => {
                                    setMenuFor(null);
                                    setShareFor(conversation);
                                  }}
                                >
                                  <Icon.share /> Share
                                </button>
                                <ConfirmButton
                                  className="user-pop__btn"
                                  message="Delete this chat?"
                                  confirmLabel="Delete"
                                  onConfirm={() => deleteConversation(conversation)}
                                >
                                  <Icon.trash /> Delete
                                </ConfirmButton>
                              </div>
                            ) : null}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </nav>

        {isAdmin ? (
          <>
            <div className="lr__section">Admin</div>
            <nav className="lr__nav" aria-label="Admin sections">
              {adminNav.map((item) => {
                const active = isActivePath(pathname, item.href);
                const badge = counts[item.id] ?? item.badge;
                return (
                  <Link key={item.id} href={item.href} aria-current={active ? "page" : undefined} className={active ? "on" : undefined} onClick={onNavigate}>
                    {item.icon}
                    <span>{item.label}</span>
                    {badge ? <span className="badge">{badge}</span> : null}
                  </Link>
                );
              })}
            </nav>
          </>
        ) : null}
      </div>


      <UserFooter displayName={displayName} initials={initials} onNavigate={onNavigate} />

      {shareFor ? <ShareDialog conversation={shareFor} onClose={() => setShareFor(null)} /> : null}
    </aside>
  );
}

function ShareDialog({ conversation, onClose }: { conversation: ChatItem; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  // Parent re-renders hand us a fresh `onClose` function each time. Keep it in a
  // ref so the modal-lifecycle effect below can run once on mount instead of
  // tearing the dialog down (and unmounting it) on every parent render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const [shares, setShares] = useState<ConversationShare[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    function onCancel(event: Event) {
      event.preventDefault();
      onCloseRef.current();
    }
    dialog.addEventListener("cancel", onCancel);
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiClient.conversations.share
      .list(conversation.id)
      .then((res) => {
        if (!cancelled) setShares(res.shares ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversation.id]);

  async function createLink() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiClient.conversations.share.create(conversation.id);
      setShares((current) => [res.share, ...current.filter((share) => share.id !== res.share.id)]);
      toast({ message: "Share link ready.", variant: "success" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function revokeLink(shareId: string) {
    setError(null);
    try {
      const res = await apiClient.conversations.share.revoke(conversation.id, shareId);
      setShares((current) => current.map((share) => (share.id === shareId ? res.share : share)));
      toast({ message: "Share link revoked.", variant: "success" });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function copyLink(share: ConversationShare) {
    try {
      await navigator.clipboard.writeText(share.url);
      setCopiedId(share.id);
      window.setTimeout(() => setCopiedId((current) => (current === share.id ? null : current)), 1500);
    } catch {
      toast({ message: share.url, variant: "info" });
    }
  }

  const activeShares = shares.filter((share) => !share.revoked);

  return (
    <dialog ref={dialogRef} className="prompt-dialog share-dialog" onClose={() => onCloseRef.current()} aria-label={`Share ${conversation.title}`}>
      <div className="prompt-dialog__form">
        <header className="prompt-dialog__head">
          <h2>Share “{conversation.title}”</h2>
          <button className="ib" type="button" onClick={onClose} aria-label="Close" title="Close">
            <Icon.plus style={{ transform: "rotate(45deg)" }} />
          </button>
        </header>

        <p className="muted share-dialog__hint">
          Anyone with the link can read this conversation without an account. They cannot reply or see your account details.
        </p>

        {error ? <p className="error-state" role="alert">{error}</p> : null}

        {loading ? (
          <p className="muted">Loading share links…</p>
        ) : activeShares.length === 0 ? (
          <div className="share-dialog__empty">
            <p className="muted">No active share links for this conversation.</p>
            <button className="button button--primary" type="button" disabled={busy} onClick={() => void createLink()}>
              {busy ? "Creating…" : "Create share link"}
            </button>
          </div>
        ) : (
          <ul className="share-links">
            {activeShares.map((share) => (
              <li className="share-link" key={share.id}>
                <input
                  className="input share-link__url"
                  readOnly
                  value={share.url}
                  aria-label="Share link URL"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <div className="share-link__actions">
                  <button className="button button--ghost" type="button" onClick={() => void copyLink(share)}>
                    {copiedId === share.id ? "Copied" : "Copy link"}
                  </button>
                  <ConfirmButton className="button button--danger" message="Revoke this link?" confirmLabel="Revoke" onConfirm={() => revokeLink(share.id)}>
                    Revoke
                  </ConfirmButton>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="prompt-dialog__actions">
          <button className="button button--ghost" type="button" onClick={onClose}>Done</button>
        </div>
      </div>
    </dialog>
  );
}

function UserFooter({ displayName, initials, onNavigate }: { displayName: string; initials: string; onNavigate?: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { user, logout } = useAuth();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const email = user?.email ?? "";
  const theme = useTheme();

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
    setTheme(theme === "light" ? "dark" : "light");
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
        <span className="who">
          <span className="nm">{displayName}</span>
          {email ? <span className="nm-sub">{email}</span> : null}
        </span>
        <Icon.chev />
      </button>
      <Link className="ib" href="/settings" title="Settings" aria-label="Settings" onClick={onNavigate}>
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
              onClick={() => {
                setMenuOpen(false);
                onNavigate?.();
              }}
            >
              <span className="user-pop__icon user-pop__icon--key"><Icon.key /></span>
              API Keys
            </Link>
            <a
              role="menuitem"
              href="https://github.com/packetloss404"
              target="_blank"
              rel="noreferrer"
              className="user-pop__btn"
              onClick={() => {
                setMenuOpen(false);
                onNavigate?.();
              }}
            >
              <span className="user-pop__icon user-pop__icon--gh"><Icon.github /></span>
              GitHub
            </a>
          </div>

          <footer className="user-pop__foot">
            <div className="user-pop__links">
              Fifty Eleven LLC © 2026
            </div>
            <div className="user-pop__toggles">
<button className="user-pop__chip" type="button" onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme">
            <Icon.moon />
            <span>Theme</span>
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
  // See ShareDialog: a fresh `onClose` prop on each parent render must not
  // re-run the mount effect, or the dialog closes itself immediately.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
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
      onCloseRef.current();
    }
    dialog.addEventListener("cancel", onCancel);
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
    };
  }, []);

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
    <dialog ref={dialogRef} className="prompt-dialog" aria-label="Change password" onClose={() => onCloseRef.current()}>
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

type HeaderBarProps = {
  mobileNavOpen?: boolean;
  mobileNavButtonRef?: React.RefObject<HTMLButtonElement | null>;
  onMobileNavOpen?: () => void;
};

function HeaderBar({ mobileNavOpen = false, mobileNavButtonRef, onMobileNavOpen }: HeaderBarProps = {}) {
  const pathname = usePathname() ?? "/";
  const { title: chatTitle, modelLabel } = useChatHeader();
  const routeTitle = resolveTitle(pathname);
  const isChatRoute = pathname.startsWith("/chat");
  const title = chatTitle ?? (isChatRoute ? "New chat" : routeTitle);
  const { user, logout } = useAuth();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pathname.startsWith("/chat")) {
      setChatHeader({ title: null, modelLabel: null });
    }
  }, [pathname]);

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
      {onMobileNavOpen ? (
        <button
          ref={mobileNavButtonRef}
          className="ib hdr__nav-toggle"
          type="button"
          title="Open navigation"
          aria-label="Open navigation"
          aria-controls="primary-navigation"
          aria-expanded={mobileNavOpen}
          onClick={onMobileNavOpen}
        >
          <Icon.sidebar />
        </button>
      ) : null}
      {isChatRoute ? (
        <button
          className="hdr__model"
          type="button"
          onClick={requestModelPicker}
          title={modelLabel ? `Model: ${modelLabel}` : "Choose a model"}
          aria-label={modelLabel ? `${title} — model ${modelLabel}. Open model picker` : `${title}. Open model picker`}
        >
          <span className="dot" aria-hidden="true" />
          <span className="hdr__model-title">{title}</span>
          {modelLabel ? <span className="hdr__model-label">{modelLabel}</span> : null}
        </button>
      ) : (
        <h1 className="hdr__model" style={{ margin: 0 }}>
          <span className="dot" aria-hidden="true" />
          <span className="hdr__model-title">{title}</span>
          {modelLabel ? <span className="hdr__model-label">{modelLabel}</span> : null}
        </h1>
      )}
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
    </header>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const { status } = useAuth();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobileNavButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const openMobileNav = useCallback(() => setMobileNavOpen(true), []);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const query = window.matchMedia("(max-width: 720px)");
    if (!query.matches) {
      setMobileNavOpen(false);
      return;
    }

    function handleChange(event: MediaQueryListEvent) {
      if (!event.matches) setMobileNavOpen(false);
    }

    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, [mobileNavOpen]);

  useEffect(() => {
    if (!mobileNavOpen) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const drawer = document.getElementById("primary-navigation");
    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "textarea:not([disabled])",
      "select:not([disabled])",
      "[tabindex]:not([tabindex='-1'])"
    ].join(",");
    const getFocusable = () =>
      Array.from(drawer?.querySelectorAll<HTMLElement>(focusableSelector) ?? []).filter((element) => element.getClientRects().length > 0);
    const focusFirst = () => {
      const closeButton = drawer?.querySelector<HTMLElement>("[data-mobile-nav-close]");
      const first = closeButton ?? getFocusable()[0];
      first?.focus();
    };
    const frame = window.requestAnimationFrame(focusFirst);

    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileNavOpen(false);
        return;
      }

      if (event.key !== "Tab" || !drawer) return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!drawer.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeydown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeydown);
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      } else {
        mobileNavButtonRef.current?.focus();
      }
    };
  }, [mobileNavOpen]);

  // Signed-out visitors (i.e. the login page) get a bare frame. Rendering the
  // rails here would hand them a nav they cannot use: clicking a link would
  // mount a protected page for a moment before the auth guard bounced them
  // back to /login.
  if (status !== "authenticated") {
    return (
      <div className="app app--auth">
        <main className="main" id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    );
  }

  return (
    <div
      className="app"
      data-mobilenav={mobileNavOpen ? "open" : "closed"}
    >
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <LeftRail onMobileClose={mobileNavOpen ? closeMobileNav : undefined} onNavigate={closeMobileNav} />
      {mobileNavOpen ? (
        <button className="mobile-nav-scrim" type="button" aria-label="Close navigation" onClick={closeMobileNav} tabIndex={-1} />
      ) : null}
      <main className="main" id="main-content" tabIndex={-1} aria-hidden={mobileNavOpen ? true : undefined}>
        <HeaderBar
          mobileNavOpen={mobileNavOpen}
          mobileNavButtonRef={mobileNavButtonRef}
          onMobileNavOpen={openMobileNav}
        />
        {children}
      </main>
    </div>
  );
}

export function AppShellHeader() {
  return <HeaderBar />;
}
