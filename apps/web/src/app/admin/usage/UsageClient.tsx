"use client";

import { useEffect, useMemo, useState } from "react";
import { apiClient, type UsageResponse } from "../../../lib/api-client";
import { ErrorState, LoadingBlock, StatusBadge } from "../../../components/ui";

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatDay(value: string) {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function formatCost(value: number | null) {
  if (value === null) return "Unknown";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 6, maximumFractionDigits: 6 }).format(value);
}

function number(value: number | null) {
  return new Intl.NumberFormat().format(value ?? 0);
}

function formatKnownCost(value: number | null, unknownCount: number) {
  const knownCost = value ?? 0;
  if (unknownCount > 0 && knownCost === 0) return "Unknown";
  return unknownCount > 0 ? `${formatCost(knownCost)} + unknown` : formatCost(value);
}

function formatTokens(input: number | null, output: number | null, reasoning?: number | null, search?: number | null) {
  const parts = [`${number(input)} in`, `${number(output)} out`];
  if (reasoning) parts.push(`${number(reasoning)} reasoning`);
  if (search) parts.push(`${number(search)} search`);
  return parts.join(" / ");
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
  const governance = data.governance;

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
        <div className="card usage-page__stat"><span className="muted">Known cost</span><strong>{formatKnownCost(totalCost, unknownCostCount)}</strong></div>
        <div className="card usage-page__stat"><span className="muted">Unknown pricing</span><strong>{number(unknownCostCount)}</strong></div>
      </section>

      {governance ? (
        <section className="card">
          <div className="eyebrow">Governance</div>
          <h2>Monthly run rate and chargeback</h2>
          <div className="grid">
            <div className="card card--flat usage-page__stat"><span className="muted">Month requests</span><strong>{number(governance.totals.requests)}</strong></div>
            <div className="card card--flat usage-page__stat"><span className="muted">Active users</span><strong>{number(governance.totals.activeUsers)}</strong></div>
            <div className="card card--flat usage-page__stat"><span className="muted">Known month cost</span><strong>{formatKnownCost(governance.totals.costUsd, governance.totals.unknownCostCount)}</strong></div>
            <div className="card card--flat usage-page__stat"><span className="muted">Projected known cost</span><strong>{formatKnownCost(governance.totals.projectedMonthCostUsd, governance.totals.unknownCostCount)}</strong></div>
            <div className="card card--flat usage-page__stat"><span className="muted">Unknown pricing</span><strong>{number(governance.totals.unknownCostCount)}</strong></div>
            <div className="card card--flat usage-page__stat"><span className="muted">Estimated records</span><strong>{number(governance.totals.estimatedCount)}</strong></div>
          </div>
          {governance.recommendations.length > 0 ? (
            <div className="warning" role="status">
              {governance.recommendations.join(" ")}
            </div>
          ) : (
            <p className="muted">No cost governance warnings for the current month.</p>
          )}
        </section>
      ) : null}

      {governance ? (
        <section className="grid" aria-label="Monthly governance breakdowns">
          <div className="card">
            <div className="eyebrow">Chargeback</div>
            <h2>Top users this month</h2>
            <div className="admin-users__table-wrap" tabIndex={0} aria-label="Scrollable user chargeback table">
              <table className="admin-users__table usage-page__compact-table">
                <caption className="sr-only">Monthly usage by user</caption>
                <thead><tr><th scope="col">User</th><th scope="col">Requests</th><th scope="col">Known cost</th><th scope="col">Unknown</th></tr></thead>
                <tbody>
                  {governance.byUser.map((row) => (
                    <tr key={row.user_email}>
                      <th scope="row">{row.user_email}</th>
                      <td>{number(row.request_count)}</td>
                      <td>{formatKnownCost(row.cost_usd, row.unknown_cost_count)}</td>
                      <td>{number(row.unknown_cost_count)}</td>
                    </tr>
                  ))}
                  {governance.byUser.length === 0 ? <tr><td colSpan={4}><span className="empty-state">No user usage recorded this month.</span></td></tr> : null}
                </tbody>
              </table>
            </div>
          </div>
          <div className="card">
            <div className="eyebrow">Providers</div>
            <h2>Provider mix this month</h2>
            <div className="admin-users__table-wrap" tabIndex={0} aria-label="Scrollable provider usage table">
              <table className="admin-users__table usage-page__compact-table">
                <caption className="sr-only">Monthly usage by provider</caption>
                <thead><tr><th scope="col">Provider</th><th scope="col">Requests</th><th scope="col">Known cost</th><th scope="col">Unknown</th></tr></thead>
                <tbody>
                  {governance.byProvider.map((row) => (
                    <tr key={row.provider}>
                      <th scope="row">{row.provider}</th>
                      <td>{number(row.request_count)}</td>
                      <td>{formatKnownCost(row.cost_usd, row.unknown_cost_count)}</td>
                      <td>{number(row.unknown_cost_count)}</td>
                    </tr>
                  ))}
                  {governance.byProvider.length === 0 ? <tr><td colSpan={4}><span className="empty-state">No provider usage recorded this month.</span></td></tr> : null}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

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
                  <td>{formatTokens(row.input_tokens, row.output_tokens, row.reasoning_tokens)}</td>
                  <td>{number(row.search_queries)}</td>
                  <td>{formatKnownCost(row.cost_usd, row.unknown_cost_count)}</td>
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
                  <td>{formatTokens(row.input_tokens, row.output_tokens, row.reasoning_tokens, row.search_queries)}</td>
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
