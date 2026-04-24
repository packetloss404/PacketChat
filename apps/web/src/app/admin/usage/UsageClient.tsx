"use client";

import { useEffect, useMemo, useState } from "react";
import { apiClient, type UsageResponse } from "../../../lib/api-client";
import { ErrorState, LoadingBlock, StatusBadge } from "../../../components/ui";

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatDay(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function formatCost(value: number | null) {
  if (value === null) return "Unknown";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 6, maximumFractionDigits: 6 }).format(value);
}

function number(value: number | null) {
  return new Intl.NumberFormat().format(value ?? 0);
}

export function UsageClient() {
  const [data, setData] = useState<UsageResponse>({ summary: [], recent: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");

  async function loadUsage() {
    setLoading(true);
    setError(null);
    try {
      setData(await apiClient.admin.usage({ cache: "no-store" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load usage");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadUsage();
  }, []);

  const filteredSummary = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.summary.filter((row) => {
      const matchesQuery = !needle || [row.usage_date, row.provider, row.model, row.user_email].some((value) => value.toLowerCase().includes(needle));
      const matchesSource = sourceFilter === "all" || (sourceFilter === "estimated" ? row.estimated_count > 0 : row.estimated_count === 0);
      return matchesQuery && matchesSource;
    });
  }, [data.summary, query, sourceFilter]);
  const filteredRecent = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.recent.filter((row) => {
      const matchesQuery = !needle || [row.created_at, row.provider ?? "", row.model ?? "", row.user_email].some((value) => value.toLowerCase().includes(needle));
      const matchesSource = sourceFilter === "all" || (sourceFilter === "estimated" ? row.estimated : !row.estimated);
      return matchesQuery && matchesSource;
    });
  }, [data.recent, query, sourceFilter]);

  const totalCost = filteredSummary.reduce((sum, row) => sum + row.cost_usd, 0);
  const totalRequests = filteredSummary.reduce((sum, row) => sum + row.request_count, 0);
  const totalInputTokens = filteredSummary.reduce((sum, row) => sum + row.input_tokens, 0);
  const totalOutputTokens = filteredSummary.reduce((sum, row) => sum + row.output_tokens, 0);
  const unknownCostCount = filteredSummary.reduce((sum, row) => sum + row.unknown_cost_count, 0);

  return (
    <div className="usage-page">
      <section className="card usage-page__hero">
        <div>
          <div className="eyebrow">Admin</div>
          <h1>Usage and estimated cost</h1>
          <p className="muted">Costs are estimated from static in-app pricing and token counts. No provider billing APIs or external billing keys are used.</p>
        </div>
        <button className="button button--ghost" type="button" onClick={() => void loadUsage()} disabled={loading} aria-label="Refresh usage data">{loading ? "Loading..." : "Refresh"}</button>
      </section>

      {error ? <ErrorState message={error} onRetry={() => void loadUsage()} /> : null}
      {loading ? <LoadingBlock title="Loading usage records" /> : null}

      <section className="card admin-filter-bar" aria-label="Usage filters">
        <label>
          Search usage
          <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Provider, model, user, date" />
        </label>
        <label>
          Source
          <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>
            <option value="all">All sources</option>
            <option value="provider">Provider usage</option>
            <option value="estimated">Estimated tokens</option>
          </select>
        </label>
      </section>

      <section className="grid">
        <div className="card usage-page__stat"><span className="muted">Requests</span><strong>{number(totalRequests)}</strong></div>
        <div className="card usage-page__stat"><span className="muted">Input tokens</span><strong>{number(totalInputTokens)}</strong></div>
        <div className="card usage-page__stat"><span className="muted">Output tokens</span><strong>{number(totalOutputTokens)}</strong></div>
        <div className="card usage-page__stat"><span className="muted">Estimated cost</span><strong>{formatCost(totalCost)}</strong></div>
        <div className="card usage-page__stat"><span className="muted">Unknown pricing</span><strong>{number(unknownCostCount)}</strong></div>
      </section>

      <section className="card">
        <div className="eyebrow">Summary</div>
        <h2>Totals by date, provider, model, and user</h2>
        <div className="admin-users__table-wrap" tabIndex={0} aria-label="Scrollable usage summary table">
          <table className="admin-users__table usage-page__table">
            <caption className="sr-only">Usage totals by date, provider, model, and user</caption>
            <thead><tr><th scope="col">Date</th><th scope="col">Provider</th><th scope="col">Model</th><th scope="col">User</th><th scope="col">Requests</th><th scope="col">Tokens</th><th scope="col">Search</th><th scope="col">Cost</th><th scope="col">Notes</th></tr></thead>
            <tbody>
              {filteredSummary.map((row) => (
                <tr key={`${row.usage_date}-${row.provider}-${row.model}-${row.user_email}`}>
                  <th scope="row">{formatDay(row.usage_date)}</th>
                  <td>{row.provider}</td>
                  <td>{row.model}</td>
                  <td>{row.user_email}</td>
                  <td>{number(row.request_count)}</td>
                  <td>{number(row.input_tokens)} in / {number(row.output_tokens)} out{row.reasoning_tokens ? ` / ${number(row.reasoning_tokens)} reasoning` : ""}</td>
                  <td>{number(row.search_queries)}</td>
                  <td>{formatCost(row.cost_usd)}</td>
                  <td><div className="admin-badge-row"><StatusBadge tone={row.estimated_count ? "warning" : "success"}>{row.estimated_count ? "estimated" : "provider"}</StatusBadge>{row.unknown_cost_count ? <StatusBadge tone="danger">unknown cost</StatusBadge> : null}</div></td>
                </tr>
              ))}
              {!loading && filteredSummary.length === 0 ? <tr><td colSpan={9}><span className="empty-state">No usage records match the current filters.</span></td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="eyebrow">Recent</div>
        <h2>Latest usage records</h2>
        <div className="admin-users__table-wrap" tabIndex={0} aria-label="Scrollable recent usage table">
          <table className="admin-users__table usage-page__table">
            <caption className="sr-only">Latest usage records</caption>
            <thead><tr><th scope="col">Time</th><th scope="col">User</th><th scope="col">Provider</th><th scope="col">Model</th><th scope="col">Tokens</th><th scope="col">Cost</th><th scope="col">Source</th><th scope="col">Run</th></tr></thead>
            <tbody>
              {filteredRecent.map((row) => (
                <tr key={row.id}>
                  <th scope="row">{formatDate(row.created_at)}</th>
                  <td>{row.user_email}</td>
                  <td>{row.provider ?? "unknown"}</td>
                  <td>{row.model ?? "unknown"}</td>
                  <td>{number(row.input_tokens)} in / {number(row.output_tokens)} out</td>
                  <td>{formatCost(row.cost_usd)}</td>
                  <td><div className="admin-badge-row"><StatusBadge tone={row.estimated ? "warning" : "success"}>{row.estimated ? "estimated" : "provider"}</StatusBadge>{row.unknown_pricing ? <StatusBadge tone="danger">unknown price</StatusBadge> : null}</div></td>
                  <td>{row.conversation_run_id ? "Chat" : row.agent_run_id ? "Agent" : "Other"}</td>
                </tr>
              ))}
              {!loading && filteredRecent.length === 0 ? <tr><td colSpan={8}><span className="empty-state">No recent usage records match the current filters.</span></td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
