"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useToast } from "../../components/ui";

type Plugin = {
  id: string;
  name: string;
  author: string;
  summary: string;
  tint: string;
  initials: string;
};

const catalog: Plugin[] = [
  {
    id: "perplexity-search",
    name: "Perplexity Search",
    author: "Perplexity",
    summary: "Live web search with cited sources. Drops fresh results into chat context without leaving the conversation.",
    tint: "#1fb8cd",
    initials: "PS"
  },
  {
    id: "deep-research",
    name: "Deep Research",
    author: "packetchat",
    summary: "Plans a multi-step research task, runs iterative searches, and returns a sourced brief with confidence notes.",
    tint: "#7c3aed",
    initials: "DR"
  },
  {
    id: "gpt-image-editor",
    name: "GPT Image Editor",
    author: "OpenAI",
    summary: "Generate, edit, and mask images inline. Supports inpainting, variations, and style references.",
    tint: "#10a37f",
    initials: "IE"
  },
  {
    id: "pdf-summarizer",
    name: "PDF Summarizer",
    author: "packetchat",
    summary: "Drop in long PDFs and get structured summaries, key quotes, and topic outlines you can drill into.",
    tint: "#d97757",
    initials: "PD"
  },
  {
    id: "voice-mode",
    name: "Voice Mode",
    author: "packetchat",
    summary: "Speak to any agent and hear streaming replies. Push-to-talk or hands-free, with transcript capture.",
    tint: "#22c1d6",
    initials: "VM"
  }
];

type WaitlistEntry = { pluginId: string; email: string; at: string };
type RequestEntry = { name: string; description: string; at: string };

const WAITLIST_KEY = "packetchat.plugins.waitlist";
const REQUESTS_KEY = "packetchat.plugins.requests";
const ACCESS_TOKEN_KEY = "packetchat.accessToken";

function readWaitlist(): WaitlistEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(WAITLIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WaitlistEntry[]) : [];
  } catch {
    return [];
  }
}

function writeWaitlist(entries: WaitlistEntry[]) {
  try {
    window.localStorage.setItem(WAITLIST_KEY, JSON.stringify(entries));
  } catch {
    /* noop */
  }
}

function readRequests(): RequestEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(REQUESTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RequestEntry[]) : [];
  } catch {
    return [];
  }
}

function writeRequests(entries: RequestEntry[]) {
  try {
    window.localStorage.setItem(REQUESTS_KEY, JSON.stringify(entries));
  } catch {
    /* noop */
  }
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  backdropFilter: "blur(2px)",
  zIndex: 1000,
  display: "grid",
  placeItems: "center",
  padding: "16px"
};

const modalStyle: React.CSSProperties = {
  width: "min(440px, 100%)",
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: "14px",
  padding: "20px",
  boxShadow: "0 24px 60px rgba(0,0,0,0.45)"
};

const modalTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "16px",
  fontWeight: 600,
  color: "var(--ink)"
};

const modalSubStyle: React.CSSProperties = {
  margin: "6px 0 14px",
  fontSize: "13px",
  color: "var(--ink-3)",
  lineHeight: 1.5
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 500,
  color: "var(--ink-2)",
  marginBottom: "6px"
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 11px",
  background: "var(--bg-3)",
  border: "1px solid var(--line-2)",
  borderRadius: "8px",
  color: "var(--ink)",
  fontSize: "13px",
  fontFamily: "inherit",
  boxSizing: "border-box"
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  minHeight: "120px",
  resize: "vertical",
  lineHeight: 1.5
};

const modalActionsStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "8px",
  marginTop: "16px"
};

const ghostBtnStyle: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: "8px",
  border: "1px solid var(--line-2)",
  background: "transparent",
  color: "var(--ink-2)",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer"
};

const primaryBtnStyle: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: "8px",
  border: "1px solid #d97757",
  background: "#d97757",
  color: "#fff",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer"
};

const cardButtonResetStyle: React.CSSProperties = {
  appearance: "none",
  textAlign: "left",
  font: "inherit",
  color: "inherit",
  width: "100%",
  background: "transparent",
  border: "none",
  padding: 0,
  margin: 0,
  cursor: "default"
};

const waitlistBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "5px 12px",
  borderRadius: "999px",
  border: "1px solid #d97757",
  background: "rgba(217,119,87,0.12)",
  color: "#e89479",
  fontSize: "12px",
  fontWeight: 600,
  letterSpacing: "0.01em",
  cursor: "pointer"
};

const onWaitlistBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "5px 12px",
  borderRadius: "999px",
  border: "1px solid var(--line-2)",
  background: "var(--bg-3)",
  color: "var(--ink-3)",
  fontSize: "12px",
  fontWeight: 500,
  letterSpacing: "0.01em",
  cursor: "not-allowed"
};

const requestLinkRowStyle: React.CSSProperties = {
  marginTop: "18px",
  display: "flex",
  justifyContent: "center"
};

const requestLinkStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--ink-2)",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
  padding: "8px 12px",
  textDecoration: "underline",
  textDecorationColor: "var(--line-2)",
  textUnderlineOffset: "3px"
};

export default function PluginsPage() {
  const toast = useToast();
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const [defaultEmail, setDefaultEmail] = useState("");
  const [openWaitlistFor, setOpenWaitlistFor] = useState<Plugin | null>(null);
  const [openRequest, setOpenRequest] = useState(false);

  useEffect(() => {
    setWaitlist(readWaitlist());
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const token = window.localStorage.getItem(ACCESS_TOKEN_KEY);
    if (!token) return;
    let cancelled = false;
    fetch("/api/auth/me", { headers: { authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        const email: string | undefined = body?.user?.email ?? body?.email;
        if (typeof email === "string" && email.length > 0) {
          setDefaultEmail(email);
        }
      })
      .catch(() => {
        /* swallow — non-blocking prefill */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const joinedIds = useMemo(() => new Set(waitlist.map((entry) => entry.pluginId)), [waitlist]);

  function handleJoin(plugin: Plugin, email: string) {
    const trimmed = email.trim();
    if (!trimmed) {
      toast({ message: "Enter an email to join the waitlist", variant: "warning" });
      return;
    }
    const next: WaitlistEntry[] = [
      ...waitlist.filter((entry) => entry.pluginId !== plugin.id),
      { pluginId: plugin.id, email: trimmed, at: new Date().toISOString() }
    ];
    setWaitlist(next);
    writeWaitlist(next);
    toast({ message: `Saved local interest for ${plugin.name}`, variant: "success" });
    setOpenWaitlistFor(null);
  }

  function handleSubmitRequest(name: string, description: string) {
    const trimmedName = name.trim();
    const trimmedDesc = description.trim();
    if (!trimmedName || !trimmedDesc) {
      toast({ message: "Add a name and a short description", variant: "warning" });
      return;
    }
    const next: RequestEntry[] = [
      ...readRequests(),
      { name: trimmedName, description: trimmedDesc, at: new Date().toISOString() }
    ];
    writeRequests(next);
    toast({ message: `Saved local request: ${trimmedName}`, variant: "success" });
    setOpenRequest(false);
  }

  return (
    <div className="sheet">
      <div className="sheet__inner">
        <h1>Plugins</h1>
        <p className="sub">Preview optional capabilities for chat and agents. Interest and requests on this page are saved only in this browser.</p>

        <div className="plugin-grid">
          {catalog.map((plugin) => {
            const joined = joinedIds.has(plugin.id);
            return (
              <article
                className="plugin-card"
                key={plugin.id}
                role="group"
                tabIndex={0}
                aria-label={`${plugin.name} by ${plugin.author}`}
              >
                <div className="plugin-card__head">
                  <div className="plugin-card__logo" style={{ background: plugin.tint }} aria-hidden="true">
                    {plugin.initials}
                  </div>
                  <div className="plugin-card__meta">
                    <div className="plugin-card__name">{plugin.name}</div>
                    <div className="plugin-card__author">by {plugin.author}</div>
                  </div>
                </div>
                <p className="plugin-card__summary">{plugin.summary}</p>
                <div className="plugin-card__foot">
                  {joined ? (
                    <button type="button" disabled style={onWaitlistBtnStyle} aria-label={`Already on the ${plugin.name} waitlist`}>
                      On waitlist
                    </button>
                  ) : (
                    <button
                      type="button"
                      style={waitlistBtnStyle}
                      onClick={() => setOpenWaitlistFor(plugin)}
                      aria-label={`Join the ${plugin.name} waitlist`}
                    >
                      Join waitlist
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        <div style={requestLinkRowStyle}>
          <button
            type="button"
            style={requestLinkStyle}
            onClick={() => setOpenRequest(true)}
          >
            Request a plugin
          </button>
        </div>
      </div>

      {openWaitlistFor ? (
        <WaitlistModal
          plugin={openWaitlistFor}
          defaultEmail={defaultEmail}
          onCancel={() => setOpenWaitlistFor(null)}
          onSubmit={(email) => handleJoin(openWaitlistFor, email)}
        />
      ) : null}

      {openRequest ? (
        <RequestModal
          onCancel={() => setOpenRequest(false)}
          onSubmit={handleSubmitRequest}
        />
      ) : null}
    </div>
  );
}

function WaitlistModal({
  plugin,
  defaultEmail,
  onCancel,
  onSubmit
}: {
  plugin: Plugin;
  defaultEmail: string;
  onCancel: () => void;
  onSubmit: (email: string) => void;
}) {
  const [email, setEmail] = useState(defaultEmail);

  useEffect(() => {
    if (defaultEmail && !email) setEmail(defaultEmail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultEmail]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(email);
  }

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={`Join ${plugin.name} waitlist`} onClick={onCancel}>
      <form style={modalStyle} onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <h2 style={modalTitleStyle}>Join {plugin.name} waitlist</h2>
        <p style={modalSubStyle}>Save local interest for {plugin.name}. This does not notify PacketChat operators yet.</p>
        <label style={labelStyle} htmlFor="waitlist-email">Email</label>
        <input
          id="waitlist-email"
          type="email"
          required
          autoFocus
          style={inputStyle}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
        <div style={modalActionsStyle}>
          <button type="button" style={ghostBtnStyle} onClick={onCancel}>Cancel</button>
          <button type="submit" style={primaryBtnStyle}>Join waitlist</button>
        </div>
      </form>
    </div>
  );
}

function RequestModal({
  onCancel,
  onSubmit
}: {
  onCancel: () => void;
  onSubmit: (name: string, description: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(name, description);
  }

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Request a plugin" onClick={onCancel}>
      <form style={modalStyle} onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <h2 style={modalTitleStyle}>Request a plugin</h2>
        <p style={modalSubStyle}>Save a local note about what you&apos;d like to plug into PacketChat.</p>
        <label style={labelStyle} htmlFor="request-name">Plugin name</label>
        <input
          id="request-name"
          type="text"
          required
          autoFocus
          style={inputStyle}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Notion sync"
        />
        <div style={{ height: 12 }} />
        <label style={labelStyle} htmlFor="request-desc">What should it do?</label>
        <textarea
          id="request-desc"
          required
          style={textareaStyle}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe the workflow you want it to handle..."
        />
        <div style={modalActionsStyle}>
          <button type="button" style={ghostBtnStyle} onClick={onCancel}>Cancel</button>
          <button type="submit" style={primaryBtnStyle}>Submit request</button>
        </div>
      </form>
    </div>
  );
}
