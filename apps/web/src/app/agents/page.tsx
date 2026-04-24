"use client";

import { useEffect, useState } from "react";
import { ConfirmButton, EmptyState, LoadingBlock, StatusBadge, useToast } from "../../components/ui";
import { getAccessToken } from "../../lib/auth-client";

type Agent = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  published_version_id: string | null;
  updated_at: string;
};

type Draft = {
  agent_id: string;
  draft_id: string;
  name: string;
  description: string | null;
  status: string;
  spec: {
    name?: string;
    description?: string;
    instructions?: string;
    provider?: string;
    providerAccountId?: string;
    model?: string;
    temperature?: number;
    maxOutputTokens?: number;
    knowledgeBaseIds?: string[];
    knowledgeLimit?: number;
    tools?: {
      knowledgeSearch?: boolean;
      calculator?: boolean;
      urlFetch?: boolean;
    };
  };
  revision: number;
};

type ProviderAccount = {
  id: string;
  provider: string;
  display_name: string;
};

type ModelBinding = {
  id: string;
  provider_account_id: string;
  model: string;
  display_name: string;
};

type KnowledgeBase = {
  id: string;
  name: string;
  description: string | null;
  document_count: number;
};

type RunEvent = {
  id: string;
  sequence_no: number;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

type RunStep = {
  id: string;
  sequence_no: number;
  step_type: string;
  status: string;
  name: string | null;
  output: Record<string, unknown>;
};

function authHeaders() {
  const token = getAccessToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export default function AgentsPage() {
  const toast = useToast();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [message, setMessage] = useState("Add a bearer token to localStorage as packetchat_access_token to use the builder.");
  const [isBusy, setIsBusy] = useState(false);
  const [providerAccounts, setProviderAccounts] = useState<ProviderAccount[]>([]);
  const [modelBindings, setModelBindings] = useState<ModelBinding[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [runInput, setRunInput] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [runOutput, setRunOutput] = useState("");
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const [runSteps, setRunSteps] = useState<RunStep[]>([]);

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    const token = authHeaders().authorization;
    if (token) headers.set("authorization", token);
    if (init?.body) headers.set("content-type", "application/json");

    const response = await fetch(path, {
      ...init,
      headers
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error?.message ?? "Request failed");
    return data as T;
  }

  async function loadAgents() {
    setIsBusy(true);
    try {
      const data = await request<{ agents: Agent[] }>("/api/agents");
      setAgents(data.agents);
      setSelectedId((current) => current ?? data.agents[0]?.id ?? null);
      setMessage(data.agents.length > 0 ? "Agents loaded." : "No agents yet. Create one to start a draft.");
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      setMessage(nextError);
      toast({ title: "Unable to load agents", message: nextError, variant: "error" });
    } finally {
      setIsBusy(false);
    }
  }

  async function loadProviders() {
    try {
      const data = await request<{ accounts: ProviderAccount[]; modelBindings: ModelBinding[] }>("/api/providers");
      setProviderAccounts(data.accounts);
      setModelBindings(data.modelBindings ?? []);
    } catch {
      setProviderAccounts([]);
      setModelBindings([]);
    }
  }

  async function loadKnowledgeBases() {
    try {
      const data = await request<{ knowledgeBases: KnowledgeBase[] }>("/api/knowledge");
      setKnowledgeBases(data.knowledgeBases);
    } catch {
      setKnowledgeBases([]);
    }
  }

  async function loadDraft(agentId: string) {
    setIsBusy(true);
    try {
      const data = await request<{ draft: Draft }>(`/api/agents/${agentId}/draft`);
      setDraft(data.draft);
      setMessage("Draft loaded.");
    } catch (error) {
      setDraft(null);
      const nextError = error instanceof Error ? error.message : String(error);
      setMessage(nextError);
      toast({ title: "Unable to load draft", message: nextError, variant: "error" });
    } finally {
      setIsBusy(false);
    }
  }

  useEffect(() => {
    loadAgents();
    loadProviders();
    loadKnowledgeBases();
  }, []);

  useEffect(() => {
    if (selectedId) void loadDraft(selectedId);
  }, [selectedId]);

  async function createAgent() {
    const name = newName.trim();
    if (!name) {
      setMessage("Name is required.");
      toast({ message: "Name is required.", variant: "warning" });
      return;
    }
    setIsBusy(true);
    try {
      const data = await request<{ agentId: string }>("/api/agents", {
        method: "POST",
        body: JSON.stringify({ name, description: newDescription })
      });
      setNewName("");
      setNewDescription("");
      await loadAgents();
      setSelectedId(data.agentId);
      setMessage("Agent created with a draft.");
      toast({ message: "Agent created with a draft.", variant: "success" });
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      setMessage(nextError);
      toast({ title: "Unable to create agent", message: nextError, variant: "error" });
    } finally {
      setIsBusy(false);
    }
  }

  async function saveDraft() {
    if (!draft) return;
    setIsBusy(true);
    try {
      const spec = {
        name: draft.spec.name ?? draft.name,
        description: draft.spec.description ?? draft.description ?? "",
        instructions: draft.spec.instructions ?? "",
        provider: draft.spec.provider,
        providerAccountId: draft.spec.providerAccountId,
        model: draft.spec.model,
        temperature: typeof draft.spec.temperature === "number" ? draft.spec.temperature : undefined,
        maxOutputTokens: typeof draft.spec.maxOutputTokens === "number" ? draft.spec.maxOutputTokens : undefined,
        knowledgeBaseIds: draft.spec.knowledgeBaseIds ?? [],
        knowledgeLimit: draft.spec.knowledgeLimit ?? 5,
        tools: {
          knowledgeSearch: Boolean(draft.spec.tools?.knowledgeSearch),
          calculator: Boolean(draft.spec.tools?.calculator),
          urlFetch: Boolean(draft.spec.tools?.urlFetch)
        }
      };
      const data = await request<{ draft: Pick<Draft, "spec" | "revision"> }>(`/api/agents/${draft.agent_id}/draft`, {
        method: "PATCH",
        body: JSON.stringify({ spec })
      });
      setDraft({ ...draft, spec: data.draft.spec, revision: data.draft.revision });
      await loadAgents();
      setMessage("Draft saved.");
      toast({ message: "Draft saved.", variant: "success" });
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      setMessage(nextError);
      toast({ title: "Unable to save draft", message: nextError, variant: "error" });
    } finally {
      setIsBusy(false);
    }
  }

  async function publishDraft() {
    if (!draft) return;
    setIsBusy(true);
    try {
      const data = await request<{ version: { version_number: number } }>(`/api/agents/${draft.agent_id}/publish`, {
        method: "POST",
        body: JSON.stringify({ changeSummary: "Published from agent builder" })
      });
      await loadAgents();
      setMessage(`Published version ${data.version.version_number}.`);
      toast({ message: `Published version ${data.version.version_number}.`, variant: "success" });
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      setMessage(nextError);
      toast({ title: "Unable to publish draft", message: nextError, variant: "error" });
    } finally {
      setIsBusy(false);
    }
  }

  async function archiveAgent(agent: Agent) {
    setIsBusy(true);
    try {
      await request(`/api/agents/${agent.id}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: true })
      });
      await loadAgents();
      if (selectedId === agent.id) setDraft(null);
      setMessage("Agent archived.");
      toast({ message: "Agent archived.", variant: "success" });
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      setMessage(nextError);
      toast({ title: "Unable to archive agent", message: nextError, variant: "error" });
    } finally {
      setIsBusy(false);
    }
  }

  async function deleteAgent(agent: Agent) {
    setIsBusy(true);
    try {
      await request(`/api/agents/${agent.id}`, { method: "DELETE" });
      setAgents((current) => current.filter((item) => item.id !== agent.id));
      if (selectedId === agent.id) {
        setSelectedId(null);
        setDraft(null);
      }
      setMessage("Agent deleted.");
      toast({ message: "Agent deleted.", variant: "success" });
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      setMessage(nextError);
      toast({ title: "Unable to delete agent", message: nextError, variant: "error" });
    } finally {
      setIsBusy(false);
    }
  }

  async function pollRun(agentId: string, nextRunId: string) {
    const data = await request<{ run: { status: string; error_message: string | null }; steps: RunStep[]; events: RunEvent[] }>(`/api/agents/${agentId}/runs/${nextRunId}`);
    setRunStatus(data.run.status);
    setRunEvents(data.events);
    setRunSteps(data.steps);
    const completed = data.events.find((event) => event.event_type === "run.completed");
    const outputText = completed?.payload?.outputText;
    if (typeof outputText === "string") setRunOutput(outputText);
    if (data.run.error_message) setMessage(data.run.error_message);
  }

  async function runPublishedAgent() {
    if (!draft) return;
    const inputText = runInput.trim();
    if (!inputText) {
      setMessage("Run input is required.");
      toast({ message: "Run input is required.", variant: "warning" });
      return;
    }
    setIsBusy(true);
    setRunId(null);
    setRunStatus("running");
    setRunOutput("");
    setRunEvents([]);
    setRunSteps([]);
    try {
      const data = await request<{ runId: string; status: string; outputText?: string; error?: string }>(`/api/agents/${draft.agent_id}/runs`, {
        method: "POST",
        body: JSON.stringify({ inputText })
      });
      setRunId(data.runId);
      setRunStatus(data.status);
      setRunOutput(data.outputText ?? "");
      await pollRun(draft.agent_id, data.runId);
      setMessage(data.error ?? `Run ${data.status}.`);
      toast({ message: data.error ?? `Run ${data.status}.`, variant: data.error ? "error" : "success" });
    } catch (error) {
      setRunStatus("failed");
      const nextError = error instanceof Error ? error.message : String(error);
      setMessage(nextError);
      toast({ title: "Agent run failed", message: nextError, variant: "error" });
    } finally {
      setIsBusy(false);
    }
  }

  const selectedProviderModels = draft?.spec.providerAccountId
    ? modelBindings.filter((binding) => binding.provider_account_id === draft.spec.providerAccountId)
    : [];

  function updateSpec(next: Partial<Draft["spec"]>) {
    if (!draft) return;
    setDraft({ ...draft, spec: { ...draft.spec, ...next } });
  }

  function updateTool(tool: "knowledgeSearch" | "calculator" | "urlFetch", enabled: boolean) {
    if (!draft) return;
    setDraft({ ...draft, spec: { ...draft.spec, tools: { ...draft.spec.tools, [tool]: enabled } } });
  }

  function toggleKnowledgeBase(knowledgeBaseId: string, enabled: boolean) {
    if (!draft) return;
    const current = draft.spec.knowledgeBaseIds ?? [];
    const next = enabled ? [...new Set([...current, knowledgeBaseId])] : current.filter((id) => id !== knowledgeBaseId);
    setDraft({ ...draft, spec: { ...draft.spec, knowledgeBaseIds: next, tools: { ...draft.spec.tools, knowledgeSearch: next.length > 0 ? true : draft.spec.tools?.knowledgeSearch } } });
  }

  return (
    <section className="card agents-page">
      <div className="eyebrow">Agents</div>
      <h1>Agent builder</h1>
      <p className="muted">Create agents, edit drafts, publish immutable versions, and run published agents.</p>
      {providerAccounts.length === 0 ? (
        <div className="warning" role="status">
          Agent drafts need a provider account and model before they can run. Configure provider keys in <a className="link-button" href="/providers">Providers</a>.
        </div>
      ) : null}

      <div className="grid agents-layout">
        <div className="card nested-card agents-create">
          <h2>Create</h2>
          <label>Name</label>
          <input className="input" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Support triage" />
          <label>Description</label>
          <textarea value={newDescription} onChange={(event) => setNewDescription(event.target.value)} rows={3} />
          <button className="button" type="button" disabled={isBusy} onClick={createAgent}>Create agent</button>
        </div>

        <div className="card nested-card">
          <h2>Agents</h2>
          {isBusy && agents.length === 0 ? <LoadingBlock title="Loading agents" /> : null}
          {!isBusy && agents.length === 0 ? <EmptyState title="No agents" description="Create one to start a draft." /> : null}
          <div className="item-list">
            {agents.map((agent) => (
              <div key={agent.id} style={{ display: "grid", gap: 8 }}>
                <button
                  className="selectable-card"
                  type="button"
                  onClick={() => setSelectedId(agent.id)}
                  aria-pressed={selectedId === agent.id}
                >
                  <strong>{agent.name}</strong>
                  <div className="muted"><StatusBadge>{agent.status}</StatusBadge> {agent.published_version_id ? "published" : "draft only"}</div>
                </button>
                <div className="actions-row">
                  <ConfirmButton message={`Archive ${agent.name}?`} disabled={isBusy || agent.status === "archived"} onConfirm={() => archiveAgent(agent)}>Archive</ConfirmButton>
                  <ConfirmButton message={`Delete ${agent.name}?`} confirmLabel="Delete" disabled={isBusy} onConfirm={() => deleteAgent(agent)}>Delete</ConfirmButton>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card nested-card agents-panel">
        <h2>Draft</h2>
        {!draft ? <EmptyState title="No draft selected" description="Select or create an agent to edit its draft." /> : (
          <>
            <label>Name</label>
            <input
              className="input"
              value={draft.spec.name ?? draft.name}
              onChange={(event) => updateSpec({ name: event.target.value })}
            />
            <label>Description</label>
            <textarea
              value={draft.spec.description ?? draft.description ?? ""}
              onChange={(event) => updateSpec({ description: event.target.value })}
              rows={3}
            />
            <label>Instructions</label>
            <textarea
              value={draft.spec.instructions ?? ""}
              onChange={(event) => updateSpec({ instructions: event.target.value })}
              rows={8}
              placeholder="Describe the agent's role, tone, constraints, and when it should use selected context."
            />
            <div className="grid agents-field-grid">
              <div>
                <label>Provider account</label>
                <select
                  aria-label="Agent provider account"
                  value={draft.spec.providerAccountId ?? ""}
                  onChange={(event) => {
                    const account = providerAccounts.find((item) => item.id === event.target.value);
                    updateSpec({ providerAccountId: event.target.value || undefined, provider: account?.provider, model: undefined });
                  }}
                >
                  <option value="">Select a provider account</option>
                  {providerAccounts.map((account) => (
                    <option key={account.id} value={account.id}>{account.display_name} ({account.provider})</option>
                  ))}
                </select>
              </div>
              <div>
                <label>Model or deployment</label>
                {selectedProviderModels.length > 0 ? (
                  <select value={draft.spec.model ?? ""} onChange={(event) => updateSpec({ model: event.target.value || undefined })}>
                    <option value="">Select a synced model</option>
                    {selectedProviderModels.map((binding) => (
                      <option key={binding.id} value={binding.model}>{binding.display_name || binding.model}</option>
                    ))}
                  </select>
                ) : (
                    <input
                      className="input"
                      aria-label="Agent model or deployment"
                    value={draft.spec.model ?? ""}
                    onChange={(event) => updateSpec({ model: event.target.value })}
                    placeholder="gpt-4.1-mini or Azure deployment name"
                  />
                )}
              </div>
            </div>
            <p className="muted">Uses existing provider accounts only. Sync models from Providers for a dropdown, or type a deployment/model name manually.</p>
            <div className="grid agents-field-grid">
              <div>
                <label>Temperature</label>
                <input
                  className="input"
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={draft.spec.temperature ?? 0.7}
                  onChange={(event) => updateSpec({ temperature: Number(event.target.value) })}
                />
              </div>
              <div>
                <label>Max output tokens</label>
                <input
                  className="input"
                  type="number"
                  min="1"
                  max="32000"
                  step="1"
                  value={draft.spec.maxOutputTokens ?? 1024}
                  onChange={(event) => updateSpec({ maxOutputTokens: Number(event.target.value) })}
                />
              </div>
            </div>
            <h3>Knowledge and tools</h3>
            <label className="checkbox-row">
              <input type="checkbox" checked={Boolean(draft.spec.tools?.knowledgeSearch)} onChange={(event) => updateTool("knowledgeSearch", event.target.checked)} />
              Add selected knowledge search results as pre-run context
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={Boolean(draft.spec.tools?.calculator)} onChange={(event) => updateTool("calculator", event.target.checked)} />
              Calculator for simple arithmetic prompts
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={Boolean(draft.spec.tools?.urlFetch)} onChange={(event) => updateTool("urlFetch", event.target.checked)} />
              Fetch URLs from the prompt as read-only context
            </label>
            <div className="grid agents-field-grid">
              <div>
                <label>Knowledge result limit</label>
                <input
                  className="input"
                  type="number"
                  min="1"
                  max="10"
                  value={draft.spec.knowledgeLimit ?? 5}
                  onChange={(event) => updateSpec({ knowledgeLimit: Number(event.target.value) })}
                />
              </div>
              <div>
                <label>Knowledge bases</label>
                {knowledgeBases.length === 0 ? <EmptyState title="No knowledge bases" description="Create a knowledge base before attaching one to an agent." /> : null}
                <div className="checkbox-list">
                  {knowledgeBases.map((kb) => (
                    <label key={kb.id} className="checkbox-row">
                      <input type="checkbox" checked={(draft.spec.knowledgeBaseIds ?? []).includes(kb.id)} onChange={(event) => toggleKnowledgeBase(kb.id, event.target.checked)} />
                      {kb.name} ({kb.document_count} docs)
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <p className="muted">Revision {draft.revision}</p>
            <div className="actions-row">
              <button className="button" type="button" disabled={isBusy} onClick={saveDraft}>Save draft</button>
              <button className="button" type="button" disabled={isBusy} onClick={publishDraft}>Publish version</button>
            </div>
          </>
        )}
      </div>

      <div className="card nested-card agents-panel">
        <h2>Run published agent</h2>
        {!draft ? <EmptyState title="No agent selected" description="Select an agent before running." /> : (
          <>
            <label>Input</label>
            <textarea aria-label="Agent run input" value={runInput} onChange={(event) => setRunInput(event.target.value)} rows={4} placeholder="Ask the agent to do something." />
            <div className="actions-row">
              <button className="button" type="button" disabled={isBusy} onClick={runPublishedAgent}>Run published version</button>
            </div>
            {runId ? <p className="muted">Run {runId} · {runStatus}</p> : null}
            {runStatus === "running" ? <LoadingBlock title="Run is in progress" /> : null}
            {runOutput ? <pre style={{ whiteSpace: "pre-wrap" }}>{runOutput}</pre> : null}
            {runSteps.length > 0 ? <h3>Steps</h3> : null}
            {runSteps.map((step) => (
              <pre key={step.id} style={{ whiteSpace: "pre-wrap" }}>{step.sequence_no}. {step.step_type} · {step.status}\n{JSON.stringify(step.output, null, 2)}</pre>
            ))}
            {runEvents.length > 0 ? <h3>Trace</h3> : null}
            {runEvents.map((event) => (
              <pre key={event.id} style={{ whiteSpace: "pre-wrap" }}>{event.sequence_no}. {event.event_type}\n{JSON.stringify(event.payload, null, 2)}</pre>
            ))}
          </>
        )}
      </div>

      <p className={message.toLowerCase().includes("failed") || message.toLowerCase().includes("required") ? "error-state" : "notice"} role="status">{isBusy ? "Working... " : ""}{message}</p>
    </section>
  );
}
