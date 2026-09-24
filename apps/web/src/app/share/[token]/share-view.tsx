"use client";

import { useEffect, useState } from "react";
import { renderMarkdown } from "../../../lib/markdown";

type SharedMessage = {
  role: string;
  content: string;
  createdAt: string;
};

type ShareState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error" }
  | { status: "ready"; title: string; messages: SharedMessage[] };

function roleLabel(role: string): string {
  if (role === "assistant") return "Assistant";
  if (role === "user") return "User";
  if (role === "tool") return "Tool";
  if (role === "system") return "System";
  if (role === "developer") return "Developer";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

export function ShareView({ token }: { token: string }) {
  const [state, setState] = useState<ShareState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch(`/api/share/${encodeURIComponent(token)}`, {
          headers: { Accept: "application/json" },
          credentials: "omit"
        });
        if (response.status === 404) {
          if (!cancelled) setState({ status: "missing" });
          return;
        }
        const data = (await response.json().catch(() => null)) as
          | { share?: { title?: string; messages?: SharedMessage[] } }
          | null;
        if (!response.ok || !data?.share) {
          if (!cancelled) setState({ status: "error" });
          return;
        }
        if (cancelled) return;
        setState({
          status: "ready",
          title: data.share.title ?? "Shared conversation",
          messages: Array.isArray(data.share.messages) ? data.share.messages : []
        });
      } catch {
        if (!cancelled) setState({ status: "error" });
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.status === "loading") {
    return <p className="share-view__status muted">Loading shared conversation…</p>;
  }

  if (state.status === "missing") {
    return (
      <div className="share-view__status" role="alert">
        <h1>Share link unavailable</h1>
        <p className="muted">This link is invalid or has been revoked by its owner.</p>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="share-view__status" role="alert">
        <h1>Could not load this conversation</h1>
        <p className="muted">Please try again in a moment.</p>
      </div>
    );
  }

  return (
    <article className="share-transcript" aria-label={state.title}>
      <header className="share-transcript__head">
        <h1>{state.title}</h1>
        <p className="share-transcript__notice">Read-only shared conversation. Replies are disabled.</p>
      </header>

      {state.messages.length === 0 ? (
        <p className="muted">This conversation has no messages yet.</p>
      ) : (
        state.messages.map((message, index) => {
          const isUser = message.role === "user";
          return (
            <div className={`turn${isUser ? " turn--user" : ""}`} key={index}>
              <div className="turn__head">
                <b>{roleLabel(message.role)}</b>
                {message.createdAt ? (
                  <>
                    <span className="turn__sep" aria-hidden="true">·</span>
                    <time className="turn__time" dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
                  </>
                ) : null}
              </div>
              <div className="turn__body">
                {message.content ? renderMarkdown(message.content) : null}
              </div>
            </div>
          );
        })
      )}
    </article>
  );
}
