"use client";

import { useEffect, useMemo, useState } from "react";
import { apiClient, type ApprovalQueueItem, type ApprovalsResponse, type SafeActionActivity } from "../../lib/api-client";
import { EmptyState, ErrorState, LoadingBlock, StatusBadge, useToast } from "../../components/ui";

type QueueFilter = "all" | "pending" | "closed";

const EMPTY_DATA: ApprovalsResponse = {
  approvals: [],
  recentActions: [],
  stats: { pending: 0, approvals: 0, recentActions: 0 }
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function compactJson(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function clipped(value: unknown, max = 420) {
  const text = compactJson(value).trim();
  if (!text) return "No details recorded.";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function runText(input: Record<string, unknown>) {
  const text = input.text;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

function approvalTone(state: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (state === "pending") return "warning";
  if (state === "approved") return "success";
  if (state === "rejected") return "danger";
  return "neutral";
}

function actionCount(action: SafeActionActivity) {
  const actionResults = action.output.actionResults;
  if (Array.isArray(actionResults)) return actionResults.length;
  const fetched = action.output.fetched;
  if (Array.isArray(fetched)) return fetched.length;
  return null;
}

export default function ApprovalsPage() {
  const toast = useToast();
  const [data, setData] = useState<ApprovalsResponse>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  async function loadApprovals(options?: { quiet?: boolean }) {
    if (!options?.quiet) setLoading(true);
    setError(null);
    try {
      setData(await apiClient.approvals.list({ cache: "no-store" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load approvals");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadApprovals();
  }, []);

  const filteredApprovals = useMemo(() => {
    if (filter === "pending") return data.approvals.filter((item) => item.state === "pending");
    if (filter === "closed") return data.approvals.filter((item) => item.state !== "pending");
    return data.approvals;
  }, [data.approvals, filter]);

  async function decide(item: ApprovalQueueItem, decision: "approved" | "rejected") {
    setBusyId(item.id);
    try {
      await apiClient.approvals.decide(item.id, { decision });
      toast({ message: decision === "approved" ? "Approval recorded." : "Rejection recorded.", variant: "success" });
      await loadApprovals({ quiet: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to update approval";
      toast({ title: "Approval update failed", message, variant: "error" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="sheet">
      <div className="sheet__inner">
        <div className="approval-page">
          <section className="card approval-page__hero">
            <div>
              <div className="eyebrow">Runtime safety</div>
              <h1>Approval queue</h1>
              <p className="muted">Review pending agent action approvals and recent tool activity.</p>
            </div>
            <button className="button button--ghost" type="button" onClick={() => void loadApprovals()} disabled={loading}>
              {loading ? "Loading..." : "Refresh"}
            </button>
          </section>

          {error ? <ErrorState message={error} onRetry={() => void loadApprovals()} /> : null}
          {loading ? <LoadingBlock title="Loading approval queue" /> : null}

          <section className="grid approval-page__stats" aria-label="Approval queue stats">
            <div className="card approval-page__stat"><span className="muted">Pending</span><strong>{data.stats.pending}</strong></div>
            <div className="card approval-page__stat"><span className="muted">Approval steps</span><strong>{data.stats.approvals}</strong></div>
            <div className="card approval-page__stat"><span className="muted">Recent actions</span><strong>{data.stats.recentActions}</strong></div>
          </section>

          <section className="card approval-page__queue">
            <div className="approval-page__section-head">
              <div>
                <div className="eyebrow">Queue</div>
                <h2>Human approvals</h2>
              </div>
              <div className="admin-users__toggle" role="group" aria-label="Approval filter">
                {(["all", "pending", "closed"] as const).map((value) => (
                  <button
                    key={value}
                    className={`button ${filter === value ? "button--primary" : "button--ghost"}`}
                    type="button"
                    onClick={() => setFilter(value)}
                  >
                    {value[0].toUpperCase() + value.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {!loading && filteredApprovals.length === 0 ? (
              <EmptyState
                title="No approvals"
                description={filter === "pending" ? "There are no pending approval steps." : "No approval steps match this filter."}
              />
            ) : null}

            <div className="approval-page__list">
              {filteredApprovals.map((item) => (
                <article className="approval-card" key={item.id}>
                  <header className="approval-card__head">
                    <div>
                      <h3>{item.name}</h3>
                      <div className="approval-card__meta">
                        <span>{item.agentName}</span>
                        <span>Run {item.runId.slice(0, 8)}</span>
                        {item.requesterEmail ? <span>{item.requesterEmail}</span> : null}
                      </div>
                    </div>
                    <StatusBadge tone={approvalTone(item.state)}>{item.state}</StatusBadge>
                  </header>
                  {runText(item.runInput) ? <p className="approval-card__prompt">{runText(item.runInput)}</p> : null}
                  <pre className="agent-trace__entry">{clipped({ input: item.input, output: item.output })}</pre>
                  <footer className="approval-card__foot">
                    <span className="muted">{formatDate(item.startedAt)}</span>
                    {item.state === "pending" && item.canDecide ? (
                      <div className="approval-card__actions">
                        <button className="button button--ghost" type="button" disabled={busyId === item.id} onClick={() => void decide(item, "rejected")}>Reject</button>
                        <button className="button button--primary" type="button" disabled={busyId === item.id} onClick={() => void decide(item, "approved")}>Approve</button>
                      </div>
                    ) : null}
                    {item.state === "pending" && !item.canDecide ? <span className="muted">Waiting for an admin or agent editor.</span> : null}
                  </footer>
                </article>
              ))}
            </div>
          </section>

          <section className="card approval-page__actions">
            <div className="approval-page__section-head">
              <div>
                <div className="eyebrow">Recent</div>
                <h2>Action activity</h2>
              </div>
            </div>
            {!loading && data.recentActions.length === 0 ? (
              <EmptyState title="No action activity" description="Agent tool activity will appear after runs record tool steps." />
            ) : null}
            <div className="approval-page__activity-list">
              {data.recentActions.map((item) => (
                <article className="approval-activity" key={item.id}>
                  <div>
                    <h3>{item.name}</h3>
                    <div className="approval-card__meta">
                      <span>{item.agentName}</span>
                      <span>{item.stepType}</span>
                      {item.requesterEmail ? <span>{item.requesterEmail}</span> : null}
                      {actionCount(item) !== null ? <span>{actionCount(item)} item{actionCount(item) === 1 ? "" : "s"}</span> : null}
                    </div>
                  </div>
                  <StatusBadge>{item.status}</StatusBadge>
                  <pre className="agent-trace__entry">{clipped(item.output, 320)}</pre>
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
