"use client";

import { useEffect, useMemo, useState } from "react";
import { useToast } from "../../../components/ui";

type Teaser = {
  id: string;
  name: string;
  summary: string;
  tint: string;
  initials: string;
};

const teasers: Teaser[] = [
  {
    id: "runbook-author",
    name: "Runbook Author",
    summary: "Drafts step-by-step runbooks from your incident notes and turns them into review-ready Markdown.",
    tint: "#7c3aed",
    initials: "RA"
  },
  {
    id: "provider-healthcheck",
    name: "Provider Healthcheck",
    summary: "Pings configured LLM and tool providers, then summarises latency, errors, and quota burn.",
    tint: "#10a37f",
    initials: "PH"
  },
  {
    id: "incident-summarizer",
    name: "Incident Summarizer",
    summary: "Reads chat logs and timeline events, then produces a stakeholder-ready postmortem draft.",
    tint: "#1fb8cd",
    initials: "IS"
  }
];

type WaitlistEntry = { agentId: string; at: string };

const MARKETPLACE_KEY = "packetchat.marketplace.waitlist";

function readMarketplaceWaitlist(): WaitlistEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(MARKETPLACE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WaitlistEntry[]) : [];
  } catch {
    return [];
  }
}

function writeMarketplaceWaitlist(entries: WaitlistEntry[]) {
  try {
    window.localStorage.setItem(MARKETPLACE_KEY, JSON.stringify(entries));
  } catch {
    /* noop */
  }
}

const teaserSectionStyle: React.CSSProperties = {
  width: "min(960px, 100%)",
  margin: "0 auto",
  padding: "0 24px 64px",
  boxSizing: "border-box"
};

const teaserHeadingStyle: React.CSSProperties = {
  fontSize: "13px",
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  fontWeight: 500,
  textAlign: "center",
  margin: "0 0 16px"
};

const teaserGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
  gap: "14px"
};

const teaserCardStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  padding: "16px",
  border: "1px solid var(--line)",
  borderRadius: "12px",
  background: "var(--bg-2)"
};

const teaserHeadStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "12px"
};

const teaserLogoStyle = (tint: string): React.CSSProperties => ({
  width: 40,
  height: 40,
  borderRadius: 10,
  display: "grid",
  placeItems: "center",
  color: "#fff",
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: "0.02em",
  background: tint,
  flexShrink: 0
});

const teaserNameStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "var(--ink)"
};

const teaserBadgeStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--ink-3)",
  marginTop: 2,
  letterSpacing: "0.04em",
  textTransform: "uppercase"
};

const teaserSummaryStyle: React.CSSProperties = {
  flex: 1,
  margin: 0,
  fontSize: 13,
  lineHeight: 1.55,
  color: "var(--ink-2)"
};

const teaserFootStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 8,
  marginTop: 2
};

const installDisabledStyle: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid var(--line-2)",
  background: "var(--bg-3)",
  color: "var(--ink-3)",
  fontSize: 12,
  fontWeight: 500,
  cursor: "not-allowed"
};

const notifyBtnStyle: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid #d97757",
  background: "rgba(217,119,87,0.12)",
  color: "#e89479",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer"
};

const notifiedBtnStyle: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid var(--line-2)",
  background: "var(--bg-3)",
  color: "var(--ink-3)",
  fontSize: 12,
  fontWeight: 500,
  cursor: "not-allowed"
};

export default function MarketplacePage() {
  const toast = useToast();
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);

  useEffect(() => {
    setWaitlist(readMarketplaceWaitlist());
  }, []);

  const notifiedIds = useMemo(() => new Set(waitlist.map((entry) => entry.agentId)), [waitlist]);

  function handleNotify(teaser: Teaser) {
    if (notifiedIds.has(teaser.id)) return;
    const next: WaitlistEntry[] = [...waitlist, { agentId: teaser.id, at: new Date().toISOString() }];
    setWaitlist(next);
    writeMarketplaceWaitlist(next);
    toast({ message: `We'll let you know when ${teaser.name} is live`, variant: "success" });
  }

  return (
    <>
      <div className="coming-soon" role="region" aria-label="Agent Marketplace — feature coming soon">
        <svg className="coming-soon__art" viewBox="0 0 320 240" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <defs>
            <linearGradient id="cs-brand" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#d97757" />
              <stop offset="1" stopColor="#a94f2f" />
            </linearGradient>
            <linearGradient id="cs-sat" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#33333a" />
              <stop offset="1" stopColor="#1d1d1f" />
            </linearGradient>
            <radialGradient id="cs-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0" stopColor="#d97757" stopOpacity="0.25" />
              <stop offset="1" stopColor="#d97757" stopOpacity="0" />
            </radialGradient>
          </defs>

          <circle cx="160" cy="120" r="110" fill="url(#cs-glow)" />

          <g stroke="#33333a" strokeWidth="1" fill="none" strokeDasharray="3 5" opacity="0.6">
            <circle cx="160" cy="120" r="62" />
            <circle cx="160" cy="120" r="92" />
          </g>

          <g>
            <circle cx="160" cy="120" r="34" fill="url(#cs-brand)" />
            <circle cx="160" cy="120" r="18" fill="#0f0f10" />
          </g>

          <g>
            <circle cx="98" cy="120" r="12" fill="url(#cs-sat)" stroke="#3b3b3f" strokeWidth="1" />
            <circle cx="98" cy="120" r="5" fill="#d97757" opacity="0.9" />
          </g>
          <g>
            <circle cx="222" cy="120" r="14" fill="url(#cs-sat)" stroke="#3b3b3f" strokeWidth="1" />
            <circle cx="222" cy="120" r="6" fill="#7c3aed" opacity="0.85" />
          </g>
          <g>
            <circle cx="160" cy="58" r="10" fill="url(#cs-sat)" stroke="#3b3b3f" strokeWidth="1" />
            <circle cx="160" cy="58" r="4" fill="#1fb8cd" opacity="0.9" />
          </g>
          <g>
            <circle cx="116" cy="178" r="11" fill="url(#cs-sat)" stroke="#3b3b3f" strokeWidth="1" />
            <circle cx="116" cy="178" r="4.5" fill="#10a37f" opacity="0.9" />
          </g>
          <g>
            <circle cx="214" cy="176" r="12" fill="url(#cs-sat)" stroke="#3b3b3f" strokeWidth="1" />
            <circle cx="214" cy="176" r="5" fill="#c49a3a" opacity="0.9" />
          </g>

          <g fill="#ececec" opacity="0.9">
            <path d="M78 46 L80 51 L85 53 L80 55 L78 60 L76 55 L71 53 L76 51 Z" />
            <path d="M258 50 L259 53 L262 54 L259 55 L258 58 L257 55 L254 54 L257 53 Z" opacity="0.7" />
            <path d="M50 200 L51.5 203.5 L55 205 L51.5 206.5 L50 210 L48.5 206.5 L45 205 L48.5 203.5 Z" opacity="0.6" />
          </g>
        </svg>

        <div className="coming-soon__caption">feature coming soon</div>
      </div>

      <section style={teaserSectionStyle} aria-label="Agent teasers">
        <h2 style={teaserHeadingStyle}>previewing soon</h2>
        <div style={teaserGridStyle}>
          {teasers.map((teaser) => {
            const notified = notifiedIds.has(teaser.id);
            return (
              <article
                key={teaser.id}
                style={teaserCardStyle}
                role="group"
                tabIndex={0}
                aria-label={`${teaser.name} — preview`}
              >
                <div style={teaserHeadStyle}>
                  <div style={teaserLogoStyle(teaser.tint)} aria-hidden="true">{teaser.initials}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={teaserNameStyle}>{teaser.name}</div>
                    <div style={teaserBadgeStyle}>preview</div>
                  </div>
                </div>
                <p style={teaserSummaryStyle}>{teaser.summary}</p>
                <div style={teaserFootStyle}>
                  <button type="button" disabled style={installDisabledStyle} aria-label={`Install ${teaser.name} (disabled)`}>
                    Install
                  </button>
                  {notified ? (
                    <button type="button" disabled style={notifiedBtnStyle} aria-label={`You'll be notified about ${teaser.name}`}>
                      Notifying
                    </button>
                  ) : (
                    <button
                      type="button"
                      style={notifyBtnStyle}
                      onClick={() => handleNotify(teaser)}
                      aria-label={`Notify me when ${teaser.name} is live`}
                    >
                      Notify when live
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </>
  );
}
