"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { apiClient, type AdminOperationsResponse } from "../../../lib/api-client";
import { ErrorState, LoadingBlock, StatusBadge } from "../../../components/ui";

const emptyData: AdminOperationsResponse = {
  providerAccounts: [],
  modelBindings: [],
  knowledge: [],
  agentRuns: [],
  jobFailures: [],
  recentProviderAudits: []
};

function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
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

  if (entries.length === 0) return <span className="muted">No metadata</span>;

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

function BreakdownTable({
  caption,
  ariaLabel,
  columns,
  rows,
  loading,
  emptyText
}: {
  caption: string;
  ariaLabel: string;
  columns: string[];
  rows: Array<{ id: string; cells: ReactNode[] }>;
  loading: boolean;
  emptyText: string;
}) {
  return (
    <div className="admin-users__table-wrap" tabIndex={0} aria-label={ariaLabel}>
      <table className="admin-users__table" style={{ minWidth: 0 }}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>{columns.map((column) => <th scope="col" key={column}>{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {row.cells.map((cell, index) =>
                index === 0 ? <th scope="row" key={index}>{cell}</th> : <td key={index}>{cell}</td>
              )}
            </tr>
          ))}
          {!loading && rows.length === 0 ? <tr><td colSpan={columns.length}><span className="empty-state">{emptyText}</span></td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}

export function OperationsClient() {
  const [data, setData] = useState<AdminOperationsResponse>(emptyData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await apiClient.admin.operations({ cache: "no-store" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load operations data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const enabledProviderAccounts = useMemo(
    () => data.providerAccounts.filter((row) => row.status === "enabled").reduce((sum, row) => sum + Number(row.count), 0),
    [data.providerAccounts]
  );
  const enabledModels = useMemo(
    () => data.modelBindings.filter((row) => row.enabled).reduce((sum, row) => sum + Number(row.count), 0),
    [data.modelBindings]
  );
  const readyDocuments = useMemo(
    () => data.knowledge.filter((row) => row.ingest_status === "ready").reduce((sum, row) => sum + Number(row.count), 0),
    [data.knowledge]
  );
  const failedAgentRuns = useMemo(
    () => data.agentRuns.filter((row) => ["failed", "timed_out", "cancelled"].includes(row.status)).reduce((sum, row) => sum + Number(row.count), 0),
    [data.agentRuns]
  );

  return (
    <div className="admin-users">
      <section className="card usage-page__hero">
        <div>
          <div className="eyebrow">Admin</div>
          <h1>Operations</h1>
          <p className="muted">Provider, model, and job health at a glance.</p>
        </div>
        <button className="button button--ghost" type="button" onClick={() => void load()} disabled={loading}>{loading ? "Loading..." : "Refresh"}</button>
      </section>

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
      {loading ? <LoadingBlock title="Loading operations data" /> : null}

      <section className="grid">
        <div className="card usage-page__stat"><span className="muted">Enabled accounts</span><strong>{formatCount(enabledProviderAccounts)}</strong></div>
        <div className="card usage-page__stat"><span className="muted">Enabled models</span><strong>{formatCount(enabledModels)}</strong></div>
        <div className="card usage-page__stat"><span className="muted">Ready documents</span><strong>{formatCount(readyDocuments)}</strong></div>
        <div className="card usage-page__stat"><span className="muted">Failed runs</span><strong>{formatCount(failedAgentRuns)}</strong></div>
        <div className="card usage-page__stat"><span className="muted">Recent job failures</span><strong>{formatCount(data.jobFailures.length)}</strong></div>
      </section>

      <section className="grid">
        <article className="card">
          <div className="eyebrow">Providers</div>
          <h2>Account status</h2>
          <BreakdownTable
            caption="Provider account status"
            ariaLabel="Provider account status table"
            columns={["Provider", "Status", "Accounts"]}
            loading={loading}
            emptyText="No provider accounts yet."
            rows={data.providerAccounts.map((row) => ({
              id: `${row.provider}-${row.status}`,
              cells: [
                row.provider,
                <StatusBadge tone={row.status === "enabled" ? "success" : row.status === "disabled" ? "neutral" : "warning"}>{row.status}</StatusBadge>,
                formatCount(row.count)
              ]
            }))}
          />
        </article>

        <article className="card">
          <div className="eyebrow">Models</div>
          <h2>Model bindings</h2>
          <BreakdownTable
            caption="Model bindings by provider"
            ariaLabel="Model binding status table"
            columns={["Provider", "Status", "Models"]}
            loading={loading}
            emptyText="No model bindings yet."
            rows={data.modelBindings.map((row) => ({
              id: `${row.provider}-${row.enabled}`,
              cells: [
                row.provider,
                <StatusBadge tone={row.enabled ? "success" : "neutral"}>{row.enabled ? "enabled" : "disabled"}</StatusBadge>,
                formatCount(row.count)
              ]
            }))}
          />
        </article>

        <article className="card">
          <div className="eyebrow">Knowledge</div>
          <h2>Ingestion status</h2>
          <BreakdownTable
            caption="Knowledge ingestion status"
            ariaLabel="Knowledge ingestion status table"
            columns={["Ingestion status", "Documents"]}
            loading={loading}
            emptyText="No documents yet."
            rows={data.knowledge.map((row) => ({
              id: row.ingest_status,
              cells: [
                <StatusBadge tone={row.ingest_status === "ready" ? "success" : row.ingest_status === "failed" ? "danger" : "warning"}>{row.ingest_status}</StatusBadge>,
                formatCount(row.count)
              ]
            }))}
          />
        </article>

        <article className="card">
          <div className="eyebrow">Agents</div>
          <h2>Agent runs (7 days)</h2>
          <BreakdownTable
            caption="Agent runs in the last 7 days"
            ariaLabel="Agent run status table"
            columns={["Status", "Runs (7 days)"]}
            loading={loading}
            emptyText="No agent runs in the last 7 days."
            rows={data.agentRuns.map((row) => ({
              id: row.status,
              cells: [
                <StatusBadge tone={["completed"].includes(row.status) ? "success" : ["failed", "timed_out", "cancelled"].includes(row.status) ? "danger" : "warning"}>{row.status}</StatusBadge>,
                formatCount(row.count)
              ]
            }))}
          />
        </article>
      </section>

      <section className="card">
        <div className="eyebrow">Background jobs</div>
        <h2>Recent failures</h2>
        <div className="admin-users__table-wrap" tabIndex={0} aria-label="Scrollable job failure table">
          <table className="admin-users__table">
            <caption className="sr-only">Recent background job failures</caption>
            <thead><tr><th scope="col">Time</th><th scope="col">Queue</th><th scope="col">Job</th><th scope="col">Message</th></tr></thead>
            <tbody>
              {data.jobFailures.map((failure) => (
                <tr key={failure.id}>
                  <th scope="row">{formatDate(failure.created_at)}</th>
                  <td>{failure.queue_name}</td>
                  <td>{failure.job_name}{failure.job_id ? ` / ${failure.job_id}` : ""}</td>
                  <td>{failure.error_message}</td>
                </tr>
              ))}
              {!loading && data.jobFailures.length === 0 ? <tr><td colSpan={4}><span className="empty-state">No recent job failures.</span></td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="eyebrow">Providers</div>
        <h2>Recent provider activity</h2>
        <div className="admin-users__table-wrap" tabIndex={0} aria-label="Scrollable provider audit table">
          <table className="admin-users__table audit-page__summary-table">
            <caption className="sr-only">Recent provider audit events</caption>
            <thead><tr><th scope="col">Time</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Outcome</th><th scope="col">Target</th><th scope="col">Metadata</th></tr></thead>
            <tbody>
              {data.recentProviderAudits.map((event) => (
                <tr key={event.id}>
                  <th scope="row">{formatDate(event.created_at)}</th>
                  <td>{event.actor_email ?? event.actor_user_id ?? "System"}</td>
                  <td>{event.action}</td>
                  <td><StatusBadge tone={event.outcome === "failure" ? "danger" : "success"}>{event.outcome}</StatusBadge></td>
                  <td>{event.target_type ?? "provider"}{event.target_id ? ` / ${event.target_id}` : ""}</td>
                  <td><MetadataCell metadata={event.metadata} /></td>
                </tr>
              ))}
              {!loading && data.recentProviderAudits.length === 0 ? <tr><td colSpan={6}><span className="empty-state">No recent provider audit events.</span></td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
