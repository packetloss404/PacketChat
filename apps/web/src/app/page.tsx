"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const quickActions = [
  { href: "/chat", title: "Open chat", description: "Start or resume a conversation with your configured model routes." },
  { href: "/knowledge", title: "Manage knowledge", description: "Upload documents, check ingestion, and test retrieval snippets." },
  { href: "/agents", title: "Build agents", description: "Configure instructions, tools, knowledge, and published test runs." },
  { href: "/providers", title: "Provider settings", description: "Manage global keys, BYOK accounts, model sync, and diagnostics." }
];

const systemAreas: Array<[string, string]> = [
  ["Workspace", "Chat, projects, and agents are private to each signed-in user."],
  ["Routing", "Provider accounts choose the model route; PacketChat keeps account/provider mismatches out of chat."],
  ["Knowledge", "Local extraction and deterministic embeddings support retrieval without external vector services."],
  ["Operations", "Docker Compose runs web, worker, Postgres, Redis, and MinIO behind your external proxy."]
];

type MeUser = {
  id: string;
  email: string;
  displayName?: string | null;
  role?: string;
  status?: string;
};

type HealthState =
  | { state: "loading" }
  | { state: "healthy" }
  | { state: "error"; message: string };

const arrowStyle: React.CSSProperties = {
  position: "absolute",
  right: 12,
  bottom: 10,
  opacity: 0.6,
  pointerEvents: "none"
};

const heroStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16
};

const dotBase: React.CSSProperties = {
  display: "inline-block",
  width: 10,
  height: 10,
  borderRadius: "50%",
  marginRight: 8,
  verticalAlign: "middle"
};

export default function HomePage() {
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [resumeHref, setResumeHref] = useState<string>("/chat");
  const [health, setHealth] = useState<HealthState>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) return null;
        const data = (await response.json().catch(() => null)) as { user?: MeUser } | null;
        return data?.user ?? null;
      })
      .then((user) => {
        if (cancelled || !user) return;
        const name = user.displayName?.trim() || user.email || null;
        if (name) setDisplayName(name);
      })
      .catch(() => {
        /* graceful fallback */
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      const lastId = window.localStorage.getItem("packetchat.lastConversationId");
      if (lastId) {
        setResumeHref(`/chat?conversation=${encodeURIComponent(lastId)}`);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/healthz", { credentials: "include" })
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: { message?: string } } | null;
        if (cancelled) return;
        if (response.ok && data?.ok) {
          setHealth({ state: "healthy" });
        } else {
          const message = data?.error?.message || `Health check failed (${response.status})`;
          setHealth({ state: "error", message });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Health check failed";
        setHealth({ state: "error", message });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const greeting = displayName ? `Welcome back, ${displayName}` : "Welcome";

  return (
    <div className="sheet">
      <div className="sheet__inner">
        <section className="card" style={heroStyle}>
          <div>
            <div className="eyebrow">PacketChat</div>
            <h1 style={{ margin: "4px 0 6px" }}>{greeting}</h1>
            <p className="sub" style={{ margin: 0 }}>
              Private chat, knowledge, providers, and agents routed through a small-instance workspace for local users, admin-managed provider keys, optional BYOK, and operational visibility.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link className="button" href={resumeHref}>Resume last chat</Link>
          </div>
        </section>

        <div className="home-dashboard">
          <div className="home-dashboard__quick-grid">
            {quickActions.map((action) => (
              <Link
                className="card home-dashboard__quick-card"
                href={action.href}
                key={action.href}
                style={{ position: "relative" }}
              >
                <h2>{action.title}</h2>
                <p className="muted">{action.description}</p>
                <span aria-hidden="true" style={arrowStyle}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M4 12L12 4M12 4H6M12 4V10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </Link>
            ))}
          </div>

          <h2>How the pieces fit</h2>
          <div className="grid">
            {systemAreas.map(([title, description]) => (
              <article className="card card--flat" key={title}>
                <h3>{title}</h3>
                <p className="muted">{description}</p>
              </article>
            ))}
          </div>

          <article className="card card--flat" aria-live="polite">
            <h3 style={{ marginTop: 0 }}>System status</h3>
            {health.state === "loading" ? (
              <p className="muted" style={{ margin: 0 }}>
                <span style={{ ...dotBase, background: "var(--line-2, #888)" }} aria-hidden="true" />
                Checking…
              </p>
            ) : health.state === "healthy" ? (
              <p className="muted" style={{ margin: 0 }}>
                <span style={{ ...dotBase, background: "#22c55e" }} aria-hidden="true" />
                Healthy
              </p>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                <span style={{ ...dotBase, background: "#ef4444" }} aria-hidden="true" />
                {health.message}
              </p>
            )}
          </article>
        </div>
      </div>

      <style jsx>{`
        .home-dashboard__quick-card:focus-visible {
          outline: 2px solid var(--accent, #6366f1);
          outline-offset: 2px;
          border-color: var(--accent, #6366f1);
        }
      `}</style>
    </div>
  );
}
