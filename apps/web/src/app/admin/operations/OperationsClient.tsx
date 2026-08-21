"use client";

import { useEffect, useMemo, useState } from "react";
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

function sumRows(rows: Array<{ count: number }>) {
  return rows.reduce((sum, row) => sum + Number(row.count), 0);
}

function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatMetadata(value: Record<string, unknown> | null | undefined) {
  if (!value || Object.keys(value).length === 0) return "No metadata";
  try {
    return JSON.stringify(value);
  } catch {
    return "Metadata unavailable";
  }
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
          <div className="admin-badge-row">
            {data.providerAccounts.map((row) => (
              <StatusBadge key={`${row.provider}-${row.scope}-${row.status}`} tone={row.status === "enabled" ? "success" : "warning"}>
                {`${row.provider} / ${row.scope} / ${row.status}: ${formatCount(row.count)}`}
              </StatusBadge>
            ))}
            {!loading && data.providerAccounts.length === 0 ? <span className="muted">No provider accounts yet.</span> : null}
          </div>
        </article>

        <article className="card">
          <div className="eyebrow">Models</div>
          <h2>Model bindings</h2>
          <div className="admin-badge-row">
            {data.modelBindings.map((row) => (
              <StatusBadge key={`${row.provider}-${row.enabled}`} tone={row.enabled ? "success" : "warning"}>
                {`${row.provider} / ${row.enabled ? "enabled" : "disabled"}: ${formatCount(row.count)}`}
              </StatusBadge>
            ))}
            {!loading && data.modelBindings.length === 0 ? <span className="muted">No model bindings yet.</span> : null}
          </div>
        </article>

        <article className="card">
          <div className="eyebrow">Knowledge</div>
          <h2>Ingestion status</h2>
          <div className="admin-badge-row">
            {data.knowledge.map((row) => (
              <StatusBadge key={row.ingest_status} tone={row.ingest_status === "ready" ? "success" : row.ingest_status === "failed" ? "danger" : "warning"}>
                {`${row.ingest_status}: ${formatCount(row.count)}`}
              </StatusBadge>
            ))}
            {!loading && data.knowledge.length === 0 ? <span className="muted">No documents yet.</span> : null}
          </div>
        </article>

        <article className="card">
          <div className="eyebrow">Agents</div>
          <h2>Agent runs (7 days)</h2>
          <div className="admin-badge-row">
            {data.agentRuns.map((row) => (
              <StatusBadge key={row.status} tone={["completed"].includes(row.status) ? "success" : ["failed", "timed_out", "cancelled"].includes(row.status) ? "danger" : "warning"}>
                {`${row.status}: ${formatCount(row.count)}`}
              </StatusBadge>
            ))}
            {!loading && sumRows(data.agentRuns) === 0 ? <span className="muted">No agent runs in the last 7 days.</span> : null}
          </div>
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
                  <td><code className="audit-page__metadata">{formatMetadata(event.metadata)}</code></td>
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
