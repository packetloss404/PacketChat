"use client";

import { useEffect, useState } from "react";
import { authFetch } from "../../../lib/auth-client";

type SummaryRow = {
  usage_date: string;
  provider: string;
  model: string;
  user_email: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  search_queries: number;
  cost_usd: number;
  unknown_cost_count: number;
  estimated_count: number;
};

type RecentRow = {
  id: string;
  created_at: string;
  user_email: string;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  search_queries: number | null;
  cost_usd: number | null;
  estimated: boolean;
  unknown_pricing: boolean;
  conversation_run_id: string | null;
  agent_run_id: string | null;
};

type UsageResponse = {
  summary: SummaryRow[];
  recent: RecentRow[];
};

type ApiError = {
  error?: { message?: string };
};

async function parseResponse<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & ApiError;
  if (!response.ok) throw new Error(data.error?.message ?? `Request failed with ${response.status}`);
  return data;
}

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

  async function loadUsage() {
    setLoading(true);
    setError(null);
    try {
      setData(await parseResponse<UsageResponse>(await authFetch("/api/admin/usage", { cache: "no-store" })));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load usage");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadUsage();
  }, []);

  const totalCost = data.summary.reduce((sum, row) => sum + row.cost_usd, 0);
  const totalRequests = data.summary.reduce((sum, row) => sum + row.request_count, 0);
  const totalInputTokens = data.summary.reduce((sum, row) => sum + row.input_tokens, 0);
  const totalOutputTokens = data.summary.reduce((sum, row) => sum + row.output_tokens, 0);

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

      {error ? <div className="error-state" role="alert">{error}</div> : null}
      {loading ? <div className="loading-state" role="status">Loading usage records...</div> : null}

      <section className="grid">
        <div className="card usage-page__stat"><span className="muted">Requests</span><strong>{number(totalRequests)}</strong></div>
        <div className="card usage-page__stat"><span className="muted">Input tokens</span><strong>{number(totalInputTokens)}</strong></div>
        <div className="card usage-page__stat"><span className="muted">Output tokens</span><strong>{number(totalOutputTokens)}</strong></div>
        <div className="card usage-page__stat"><span className="muted">Estimated cost</span><strong>{formatCost(totalCost)}</strong></div>
      </section>

      <section className="card">
        <div className="eyebrow">Summary</div>
        <h2>Totals by date, provider, model, and user</h2>
        <div className="admin-users__table-wrap">
          <table className="admin-users__table usage-page__table">
            <thead><tr><th>Date</th><th>Provider</th><th>Model</th><th>User</th><th>Requests</th><th>Tokens</th><th>Search</th><th>Cost</th><th>Notes</th></tr></thead>
            <tbody>
              {data.summary.map((row) => (
                <tr key={`${row.usage_date}-${row.provider}-${row.model}-${row.user_email}`}>
                  <td>{formatDay(row.usage_date)}</td>
                  <td>{row.provider}</td>
                  <td>{row.model}</td>
                  <td>{row.user_email}</td>
                  <td>{number(row.request_count)}</td>
                  <td>{number(row.input_tokens)} in / {number(row.output_tokens)} out{row.reasoning_tokens ? ` / ${number(row.reasoning_tokens)} reasoning` : ""}</td>
                  <td>{number(row.search_queries)}</td>
                  <td>{formatCost(row.cost_usd)}</td>
                  <td>{row.estimated_count ? `${row.estimated_count} estimated` : "Provider usage"}{row.unknown_cost_count ? `; ${row.unknown_cost_count} unknown cost` : ""}</td>
                </tr>
              ))}
              {!loading && data.summary.length === 0 ? <tr><td colSpan={9}><span className="empty-state">No usage records yet. Chat or agent runs will appear here after provider calls complete.</span></td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="eyebrow">Recent</div>
        <h2>Latest usage records</h2>
        <div className="admin-users__table-wrap">
          <table className="admin-users__table usage-page__table">
            <thead><tr><th>Time</th><th>User</th><th>Provider</th><th>Model</th><th>Tokens</th><th>Cost</th><th>Source</th><th>Run</th></tr></thead>
            <tbody>
              {data.recent.map((row) => (
                <tr key={row.id}>
                  <td>{formatDate(row.created_at)}</td>
                  <td>{row.user_email}</td>
                  <td>{row.provider ?? "unknown"}</td>
                  <td>{row.model ?? "unknown"}</td>
                  <td>{number(row.input_tokens)} in / {number(row.output_tokens)} out</td>
                  <td>{formatCost(row.cost_usd)}</td>
                  <td>{row.estimated ? "Estimated tokens" : "Provider usage"}{row.unknown_pricing ? "; unknown price" : ""}</td>
                  <td>{row.conversation_run_id ? "Chat" : row.agent_run_id ? "Agent" : "Other"}</td>
                </tr>
              ))}
              {!loading && data.recent.length === 0 ? <tr><td colSpan={8}><span className="empty-state">No recent usage records.</span></td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
