"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  apiClient,
  type PacketAgentConnection,
  type PacketAgentConnectionCreated,
  type PacketAgentInspectResult,
  type PacketAgentRunView
} from "../../lib/api-client";
import { EmptyState, ErrorState, LoadingBlock, StatusBadge, useToast } from "../ui";

type PacketAgentPanelProps = {
  projectId: string;
};

const displayTone: Record<PacketAgentRunView["displayState"], "success" | "warning" | "danger" | "info" | "neutral"> = {
  completed: "success",
  progress: "info",
  attention: "warning",
  failed: "danger",
  cancelled: "neutral",
  budget_exceeded: "warning",
  unknown: "neutral"
};

const displayLabel: Record<PacketAgentRunView["displayState"], string> = {
  completed: "Completed",
  progress: "In progress",
  attention: "Needs attention",
  failed: "Failed",
  cancelled: "Cancelled",
  budget_exceeded: "Budget exceeded",
  unknown: "Unknown"
};

function formatUpdated(value?: string | null) {
  if (!value) return "recently";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function budgetSummary(budget: PacketAgentRunView["budget"]) {
  const usage = budget?.usage ?? {};
  const limits = budget?.limits ?? {};
  const parts: string[] = [];
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number") parts.push(`${key}: ${value}${typeof limits[key] === "number" ? `/${limits[key]}` : ""}`);
  }
  return parts.slice(0, 4).join(" · ");
}

function evidenceId(evidence: PacketAgentRunView["evidence"]) {
  return typeof evidence === "object" && evidence && "id" in evidence ? String((evidence as { id?: unknown }).id ?? "") : "";
}

export function PacketAgentPanel({ projectId }: PacketAgentPanelProps) {
  const toast = useToast();
  const [connections, setConnections] = useState<PacketAgentConnection[]>([]);
  const [runs, setRuns] = useState<PacketAgentRunView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<PacketAgentConnectionCreated | null>(null);
  const [busyConnectionId, setBusyConnectionId] = useState<string | null>(null);

  const [newConnection, setNewConnection] = useState({
    name: "",
    workspaceId: "",
    deploymentId: "",
    agentBaseUrl: "",
    agentToken: ""
  });
  const [creating, setCreating] = useState(false);

  const [startConnectionId, setStartConnectionId] = useState("");
  const [startDeploymentId, setStartDeploymentId] = useState("");
  const [startInput, setStartInput] = useState("");
  const [starting, setStarting] = useState(false);

  const [inspectByRun, setInspectByRun] = useState<Record<string, PacketAgentInspectResult | { error: string }>>({});
  const [inspectingId, setInspectingId] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [connectionData, runData] = await Promise.all([
      apiClient.packetAgent.connections.list(projectId),
      apiClient.packetAgent.runs.list(projectId)
    ]);
    setConnections(connectionData.connections ?? []);
    setRuns(runData.runs ?? []);
    setStartConnectionId((current) => current || connectionData.connections?.[0]?.id || "");
  }, [projectId]);

  useEffect(() => {
    load()
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [load]);

  const defaultDeployment = useMemo(
    () => connections.find((connection) => connection.id === startConnectionId)?.deploymentId ?? "",
    [connections, startConnectionId]
  );

  async function createConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const result = await apiClient.packetAgent.connections.create(projectId, {
        name: newConnection.name.trim(),
        workspaceId: newConnection.workspaceId.trim(),
        deploymentId: newConnection.deploymentId.trim() || undefined,
        agentBaseUrl: newConnection.agentBaseUrl.trim(),
        agentToken: newConnection.agentToken.trim()
      });
      setCreated(result);
      setNewConnection({ name: "", workspaceId: "", deploymentId: "", agentBaseUrl: "", agentToken: "" });
      await load();
      toast({ title: "Connection created", message: result.connection.name, variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast({ title: "Connection failed", message, variant: "error" });
    } finally {
      setCreating(false);
    }
  }

  async function rotate(connection: PacketAgentConnection) {
    setBusyConnectionId(connection.id);
    setError(null);
    try {
      const result = await apiClient.packetAgent.connections.rotate(projectId, connection.id);
      setCreated(result);
      await load();
      toast({ title: "Token rotated", message: connection.name, variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast({ title: "Rotate failed", message, variant: "error" });
    } finally {
      setBusyConnectionId(null);
    }
  }

  async function revoke(connection: PacketAgentConnection) {
    setBusyConnectionId(connection.id);
    setError(null);
    try {
      await apiClient.packetAgent.connections.remove(projectId, connection.id);
      await load();
      toast({ title: "Connection revoked", message: connection.name, variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast({ title: "Revoke failed", message, variant: "error" });
    } finally {
      setBusyConnectionId(null);
    }
  }

  async function startRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!startConnectionId) {
      setError("Choose a connection before starting a run.");
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const result = await apiClient.packetAgent.runs.start(projectId, {
        connectionId: startConnectionId,
        deploymentId: startDeploymentId.trim() || undefined,
        input: startInput.trim() ? { text: startInput.trim() } : undefined
      });
      toast({ title: "Run requested", message: `Deployment ${result.deploymentId}`, variant: "success" });
      setStartInput("");
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast({ title: "Run start failed", message, variant: "error" });
    } finally {
      setStarting(false);
    }
  }

  async function inspect(run: PacketAgentRunView) {
    setInspectingId(run.id);
    try {
      const result = await apiClient.packetAgent.runs.inspect(projectId, run.id);
      setInspectByRun((current) => ({ ...current, [run.id]: result }));
    } catch (err) {
      setInspectByRun((current) => ({ ...current, [run.id]: { error: err instanceof Error ? err.message : String(err) } }));
    } finally {
      setInspectingId(null);
    }
  }

  async function openRun(run: PacketAgentRunView) {
    setOpeningId(run.id);
    try {
      const result = await apiClient.packetAgent.runs.open(projectId, run.id);
      if (result.ok) {
        window.open(result.url, "_blank", "noopener,noreferrer");
      } else {
        toast({ title: "Open link expired", message: result.message, variant: "warning" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast({ title: "Open failed", message, variant: "error" });
    } finally {
      setOpeningId(null);
    }
  }

  return (
    <section className="packet-agent" aria-label="PacketAgent">
      <div className="panel-title">
        <div>
          <div className="eyebrow">PacketAgent</div>
          <h3>Worker runs</h3>
          <p className="muted">
            Connect this project to a PacketAgent deployment. Signed callback URLs stay server-side and are proxied for you.
          </p>
        </div>
      </div>

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      {created ? (
        <div className="packet-agent-reveal" role="status">
          <strong>Copy these now — the ingest token is shown once.</strong>
          <label>
            Endpoint
            <input className="input" readOnly value={created.endpointUrl} onFocus={(event) => event.currentTarget.select()} />
          </label>
          <label>
            Bearer token
            <input className="input" readOnly value={created.ingestToken.token} onFocus={(event) => event.currentTarget.select()} />
          </label>
          <label>
            Route config
            <textarea className="input" readOnly rows={6} value={JSON.stringify(created.routeConfig, null, 2)} />
          </label>
          <button className="button button--ghost" type="button" onClick={() => setCreated(null)}>Dismiss</button>
        </div>
      ) : null}

      <div className="packet-agent-grid">
        <div className="card packet-agent-card">
          <div className="eyebrow">Connections</div>
          {loading ? <LoadingBlock title="Loading connections" /> : null}
          {!loading && connections.length === 0 ? (
            <EmptyState title="No connections" description="Add a PacketAgent deployment to start runs." />
          ) : null}
          <div className="packet-agent-connection-list">
            {connections.map((connection) => (
              <div className="packet-agent-connection" key={connection.id}>
                <div className="packet-agent-connection__head">
                  <strong>{connection.name}</strong>
                  <StatusBadge tone={connection.rotatedAt ? "info" : "success"}>
                    {connection.rotatedAt ? "Rotated" : "Active"}
                  </StatusBadge>
                </div>
                <small className="muted">{connection.agentBaseUrl}</small>
                <div className="projects-prompts-chip-row">
                  <span className="projects-prompts-chip">workspace {connection.workspaceId}</span>
                  {connection.deploymentId ? <span className="projects-prompts-chip">deployment {connection.deploymentId}</span> : null}
                  <span className="projects-prompts-chip">token {connection.ingestTokenPrefix}…</span>
                </div>
                <div className="packet-agent-connection__actions">
                  <button className="button button--ghost" type="button" disabled={busyConnectionId === connection.id} onClick={() => void rotate(connection)}>
                    Rotate token
                  </button>
                  <button className="button button--danger" type="button" disabled={busyConnectionId === connection.id} onClick={() => void revoke(connection)}>
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <form className="card packet-agent-card" onSubmit={(event) => void createConnection(event)} aria-label="Add PacketAgent connection">
          <div className="eyebrow">Add connection</div>
          <label>
            Name
            <input className="input" value={newConnection.name} onChange={(event) => setNewConnection((current) => ({ ...current, name: event.target.value }))} required />
          </label>
          <label>
            PacketAgent workspace id
            <input className="input" value={newConnection.workspaceId} onChange={(event) => setNewConnection((current) => ({ ...current, workspaceId: event.target.value }))} required />
          </label>
          <label>
            Deployment id (optional)
            <input className="input" value={newConnection.deploymentId} onChange={(event) => setNewConnection((current) => ({ ...current, deploymentId: event.target.value }))} />
          </label>
          <label>
            Agent base URL
            <input className="input" value={newConnection.agentBaseUrl} onChange={(event) => setNewConnection((current) => ({ ...current, agentBaseUrl: event.target.value }))} placeholder="https://agents.example.com" required />
          </label>
          <label>
            Agent token
            <input className="input" type="password" value={newConnection.agentToken} onChange={(event) => setNewConnection((current) => ({ ...current, agentToken: event.target.value }))} required />
          </label>
          <button className="button" type="submit" disabled={creating}>{creating ? "Adding…" : "Add connection"}</button>
        </form>
      </div>

      <form className="card packet-agent-card" onSubmit={(event) => void startRun(event)} aria-label="Start a worker run">
        <div className="eyebrow">Start a run</div>
        {connections.length === 0 ? (
          <p className="muted">Add a connection first.</p>
        ) : (
          <div className="packet-agent-start">
            <label>
              Connection
              <select className="input" value={startConnectionId} onChange={(event) => setStartConnectionId(event.target.value)}>
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>{connection.name}</option>
                ))}
              </select>
            </label>
            <label>
              Deployment id
              <input className="input" value={startDeploymentId} placeholder={defaultDeployment || "deployment id"} onChange={(event) => setStartDeploymentId(event.target.value)} />
            </label>
            <label>
              Input
              <input className="input" value={startInput} onChange={(event) => setStartInput(event.target.value)} placeholder="Optional run input" />
            </label>
            <button className="button" type="submit" disabled={starting}>{starting ? "Starting…" : "Start run"}</button>
          </div>
        )}
      </form>

      <div className="card packet-agent-card">
        <div className="eyebrow">Run cards</div>
        {loading ? <LoadingBlock title="Loading runs" /> : null}
        {!loading && runs.length === 0 ? (
          <EmptyState title="No runs yet" description="Notifications from PacketAgent will appear here as threaded run cards." />
        ) : null}
        <div className="packet-agent-run-list">
          {runs.map((run) => {
            const inspected = inspectByRun[run.id];
            return (
              <article className="packet-agent-run" key={run.id}>
                <div className="packet-agent-run__head">
                  <strong>{run.title || run.workerRunId}</strong>
                  <StatusBadge tone={displayTone[run.displayState]}>{displayLabel[run.displayState]}</StatusBadge>
                </div>
                {run.summary ? <p className="packet-agent-run__summary">{run.summary}</p> : null}
                <div className="projects-prompts-chip-row">
                  <span className="projects-prompts-chip">run {run.workerRunId}</span>
                  {budgetSummary(run.budget) ? <span className="projects-prompts-chip">{budgetSummary(run.budget)}</span> : null}
                  {run.checkpoint ? <span className="projects-prompts-chip">checkpoint {run.checkpoint.phase || run.checkpoint.sequence}</span> : null}
                  {evidenceId(run.evidence) ? <span className="projects-prompts-chip">evidence {evidenceId(run.evidence)}</span> : null}
                  {run.requiredAction && run.requiredAction !== "none" ? <span className="projects-prompts-chip projects-prompts-chip--warning">action {run.requiredAction}</span> : null}
                  <span className="projects-prompts-chip">updated {formatUpdated(run.updatedAt)}</span>
                </div>
                {inspected ? (
                  <div className="packet-agent-inspect">
                    {"error" in inspected ? (
                      <p className="muted">Inspect failed: {inspected.error}</p>
                    ) : inspected.expired ? (
                      <p className="muted">{inspected.message}</p>
                    ) : (
                      <pre>{JSON.stringify(inspected.detail, null, 2)}</pre>
                    )}
                  </div>
                ) : null}
                <div className="packet-agent-run__actions">
                  <button className="button button--ghost" type="button" disabled={inspectingId === run.id} onClick={() => void inspect(run)}>
                    {inspectingId === run.id ? "Inspecting…" : "Inspect"}
                  </button>
                  <button className="button button--ghost" type="button" disabled={openingId === run.id} onClick={() => void openRun(run)}>
                    {openingId === run.id ? "Opening…" : "Open"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
