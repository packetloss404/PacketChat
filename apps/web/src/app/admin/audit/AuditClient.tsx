"use client";

import { useEffect, useMemo, useState } from "react";
import { apiClient, type AdminAuditEvent } from "../../../lib/api-client";
import { ErrorState, LoadingBlock, StatusBadge } from "../../../components/ui";

type AuditData = {
  events: AdminAuditEvent[];
};

function formatDate(value: string | null) {
  if (!value) return "None";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatActor(event: AdminAuditEvent) {
  if (!event.actor_user_id && !event.actor_email) return "System";
  return event.actor_email ?? "Unknown user";
}

function formatMetadataValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function metadataEntries(value: Record<string, unknown> | null | undefined): Array<[string, string]> {
  if (!value) return [];
  try {
    return Object.entries(value).map(([key, entry]) => [key, formatMetadataValue(entry)]);
  } catch {
    return [];
  }
}

function metadataRaw(value: Record<string, unknown> | null | undefined) {
  if (!value || Object.keys(value).length === 0) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

function metadataSearchText(value: Record<string, unknown> | null | undefined) {
  return metadataEntries(value).map(([key, entry]) => `${key} ${entry}`).join(" ");
}

async function writeClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  if (typeof document === "undefined") return false;
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.left = "-1000px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

function MetadataCell({ metadata }: { metadata: Record<string, unknown> | null | undefined }) {
  const entries = metadataEntries(metadata);
  const raw = metadataRaw(metadata);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  if (entries.length === 0) return <span className="muted">None</span>;

  return (
    <div style={{ display: "grid", gap: "6px", maxWidth: "360px" }}>
      <dl style={{ display: "grid", gap: "3px", margin: 0 }}>
        {entries.map(([key, entry]) => (
          <div key={key} style={{ display: "grid", gap: "8px", gridTemplateColumns: "minmax(0, max-content) minmax(0, 1fr)" }}>
            <dt style={{ color: "var(--ink-4-accessible)", fontSize: "11px", fontWeight: 500 }}>{key}</dt>
            <dd style={{ color: "var(--ink-2)", fontSize: "12px", margin: 0, overflowWrap: "anywhere" }}>{entry}</dd>
          </div>
        ))}
      </dl>
      <div style={{ alignItems: "center", display: "flex", gap: "8px" }}>
        <button
          type="button"
          className="button button--ghost"
          style={{ fontSize: "11px", minHeight: "24px", padding: "2px 8px" }}
          onClick={() => {
            void writeClipboard(raw).then((ok) => setCopyState(ok ? "copied" : "error"));
          }}
        >
          Copy raw JSON
        </button>
        <span className="sr-only" role="status">
          {copyState === "copied" ? "Raw JSON metadata copied to clipboard" : copyState === "error" ? "Unable to copy metadata" : ""}
        </span>
      </div>
    </div>
  );
}

function humanizeAction(action: string) {
  const overrides: Record<string, string> = {
    "provider.models.synced": "Models synced",
    "provider.key.rotated": "API key replaced",
    "bootstrap.completed": "Setup completed"
  };
  const human = overrides[action] ?? action.replace(/[._]/g, " ");
  return human.charAt(0).toUpperCase() + human.slice(1);
}

function humanizeTarget(target: string | null | undefined) {
  if (!target) return "None";
  return target.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const emptyAuditData: AuditData = {
  events: []
};

export function AuditClient() {
  const [data, setData] = useState<AuditData>(emptyAuditData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("all");
  const [actionFilter, setActionFilter] = useState("all");

  async function loadAudit() {
    setLoading(true);
    setError(null);
    try {
      setData(await apiClient.admin.audit({ cache: "no-store" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load audit events");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAudit();
  }, []);

  const actionOptions = useMemo(() => {
    return Array.from(new Set(data.events.map((event) => event.action))).sort((left, right) => left.localeCompare(right));
  }, [data.events]);

  const actionSummary = useMemo(() => {
    const rows = new Map<string, { action: string; outcome: string; count: number }>();
    for (const event of data.events) {
      const key = `${event.action}|||${event.outcome}`;
      const row = rows.get(key) ?? { action: event.action, outcome: event.outcome, count: 0 };
      row.count += 1;
      rows.set(key, row);
    }
    return Array.from(rows.values()).sort((left, right) => right.count - left.count || left.action.localeCompare(right.action) || left.outcome.localeCompare(right.outcome));
  }, [data.events]);

  const filteredEvents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.events.filter((event) => {
      const matchesOutcome = outcomeFilter === "all" || event.outcome === outcomeFilter;
      const matchesAction = actionFilter === "all" || event.action === actionFilter;
      const matchesQuery = !needle || [
        event.created_at,
        event.actor_email ?? "",
        event.action,
        event.outcome,
        event.target_type ?? "",
        event.target_id ?? "",
        event.ip_address ?? "",
        event.user_agent ?? "",
        metadataSearchText(event.metadata)
      ].join(" ").toLowerCase().includes(needle);
      return matchesOutcome && matchesAction && matchesQuery;
    });
  }, [actionFilter, data.events, outcomeFilter, query]);

  const loadedFailureCount = data.events.filter((event) => event.outcome === "failure").length;
  const loadedActorCount = new Set(data.events.map((event) => event.actor_email ?? event.actor_user_id ?? "system")).size;
  const latestEvent = data.events[0]?.created_at ?? null;
  const visibleFailureCount = filteredEvents.filter((event) => event.outcome === "failure").length;

  return (
    <div className="audit-page">
      <section className="card audit-page__hero">
        <div>
          <div className="eyebrow">Admin</div>
          <h1>Audit log</h1>
          <p className="muted">Security, auth, user, provider, and model administration events.</p>
        </div>
        <button className="button button--ghost" type="button" onClick={() => void loadAudit()} disabled={loading} aria-label="Refresh audit log">{loading ? "Loading..." : "Refresh"}</button>
      </section>

      {error ? <ErrorState message={error} onRetry={() => void loadAudit()} /> : null}
      {loading ? <LoadingBlock title="Loading audit events" /> : null}

      <section className="grid">
        <div className="card audit-page__stat"><span className="muted">Events</span><strong>{formatCount(data.events.length)}</strong></div>
        <div className="card audit-page__stat"><span className="muted">Failures</span><strong>{formatCount(loadedFailureCount)}</strong></div>
        <div className="card audit-page__stat"><span className="muted">Actors</span><strong>{formatCount(loadedActorCount)}</strong></div>
        <div className="card audit-page__stat"><span className="muted">Actions</span><strong>{formatCount(actionOptions.length)}</strong></div>
        <div className="card audit-page__stat"><span className="muted">Latest event</span><strong>{formatDate(latestEvent)}</strong></div>
      </section>

      <section className="card admin-filter-bar" aria-label="Audit filters">
        <label>
          Search audit
          <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Actor, action, target, metadata" />
        </label>
        <label>
          Outcome
          <select value={outcomeFilter} onChange={(event) => setOutcomeFilter(event.target.value)}>
            <option value="all">All outcomes</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
          </select>
        </label>
        <label>
          Action
          <select value={actionFilter} onChange={(event) => setActionFilter(event.target.value)}>
            <option value="all">All actions</option>
            {actionOptions.map((action) => <option value={action} key={action}>{humanizeAction(action)}</option>)}
          </select>
        </label>
      </section>

      <section className="card">
        <div className="eyebrow">Summary</div>
        <h2>Action summary</h2>
        <div className="admin-users__table-wrap" tabIndex={0} aria-label="Scrollable audit summary table">
          <table className="admin-users__table audit-page__summary-table">
            <caption className="sr-only">Audit action summary</caption>
            <thead><tr><th scope="col">Action</th><th scope="col">Outcome</th><th scope="col">Events</th></tr></thead>
            <tbody>
              {actionSummary.map((row) => (
                <tr key={`${row.action}-${row.outcome}`}>
                  <th scope="row">{humanizeAction(row.action)}</th>
                  <td><StatusBadge tone={row.outcome === "failure" ? "danger" : "success"}>{row.outcome}</StatusBadge></td>
                  <td>{formatCount(row.count)}</td>
                </tr>
              ))}
              {!loading && actionSummary.length === 0 ? <tr><td colSpan={3}><span className="empty-state">No audit events have been recorded.</span></td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="admin-users__section-heading">
          <div>
            <div className="eyebrow">Events</div>
            <h2>Latest audit events</h2>
          </div>
          <div className="admin-badge-row" aria-label="Visible audit result counts">
            <StatusBadge tone="info">{`${filteredEvents.length} shown`}</StatusBadge>
            {visibleFailureCount ? <StatusBadge tone="danger">{`${visibleFailureCount} failed`}</StatusBadge> : null}
          </div>
        </div>
        <div className="admin-users__table-wrap" tabIndex={0} aria-label="Scrollable audit events table">
          <table className="admin-users__table audit-page__table">
            <caption className="sr-only">Latest audit events</caption>
            <thead><tr><th scope="col">Time</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Outcome</th><th scope="col">Target</th><th scope="col">Network</th><th scope="col">Metadata</th></tr></thead>
            <tbody>
              {filteredEvents.map((event) => (
                <tr key={event.id}>
                  <th scope="row">{formatDate(event.created_at)}</th>
                  <td><strong>{formatActor(event)}</strong>{event.actor_user_id ? <div className="muted">{event.actor_user_id}</div> : null}</td>
                  <td>{humanizeAction(event.action)}</td>
                  <td><StatusBadge tone={event.outcome === "failure" ? "danger" : "success"}>{event.outcome}</StatusBadge></td>
                  <td><div className="audit-page__target"><span>{humanizeTarget(event.target_type)}</span>{event.target_id ? <span className="muted">{event.target_id}</span> : null}</div></td>
                  <td>{event.ip_address ?? "Unknown"}{event.user_agent ? <div className="muted">{event.user_agent}</div> : null}</td>
                  <td><MetadataCell metadata={event.metadata} /></td>
                </tr>
              ))}
              {!loading && filteredEvents.length === 0 ? <tr><td colSpan={7}><span className="empty-state">No audit events match the current filters.</span></td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
