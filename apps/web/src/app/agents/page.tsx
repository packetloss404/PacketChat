"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
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
  const selectedAgent = agents.find((agent) => agent.id === selectedId) ?? null;

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
    <div className="sheet">
      <div className="sheet__inner">
        <h1>Agents</h1>
        <p className="sub">Reusable system prompts plus model + knowledge bindings. Publish freezes a version so live routes don&rsquo;t drift.</p>

        <div className="agents-lifecycle" style={{ margin: "0 0 16px" }}>
          <StatusBadge>{draft ? draft.status : selectedAgent?.status ?? "draft"}</StatusBadge>
          <span>Revision {draft?.revision ?? "-"}</span>
          <span>{selectedAgent?.published_version_id ? "Published" : "Draft only"}</span>
        </div>

        {providerAccounts.length === 0 ? (
          <div className="warning" role="status">
            Agent drafts need a provider account and model before they can run. Configure provider keys in <Link className="link-button" href="/providers">Providers</Link>.
          </div>
        ) : null}

        <div className="agents-builder__layout">
          <aside className="agents-builder__sidebar" aria-label="Agents list">
            <section className="card agents-create-card">
              <div>
                <div className="eyebrow">Create</div>
                <h2>New agent</h2>
              </div>
              <label>
                Name
                <input className="input" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Support triage" />
              </label>
              <label>
                Description
                <textarea value={newDescription} onChange={(event) => setNewDescription(event.target.value)} rows={3} />
              </label>
              <button className="button" type="button" disabled={isBusy} onClick={() => void createAgent()}>Create agent</button>
            </section>

            <section className="card agents-list-card">
              <div>
                <div className="eyebrow">Library</div>
                <h2>Agents</h2>
              </div>
              {isBusy && agents.length === 0 ? <LoadingBlock title="Loading agents" /> : null}
              {!isBusy && agents.length === 0 ? <EmptyState title="No agents" description="Create one to start a draft." /> : null}
              <div className="item-list">
                {agents.map((agent) => (
                  <div className="agent-list-item" key={agent.id}>
                    <button className="selectable-card" type="button" onClick={() => setSelectedId(agent.id)} aria-pressed={selectedId === agent.id}>
                      <strong>{agent.name}</strong>
                      <div className="agent-list-item__meta"><StatusBadge>{agent.status}</StatusBadge> <span>{agent.published_version_id ? "published" : "draft only"}</span></div>
                    </button>
                    <div className="actions-row">
                      <ConfirmButton message={`Archive ${agent.name}?`} disabled={isBusy || agent.status === "archived"} onConfirm={() => archiveAgent(agent)}>Archive</ConfirmButton>
                      <ConfirmButton className="button button--danger" message={`Delete ${agent.name}?`} confirmLabel="Delete" disabled={isBusy} onConfirm={() => deleteAgent(agent)}>Delete</ConfirmButton>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </aside>

          <main className="agents-builder__main" aria-label="Agent draft and test console">
            <section className="card agent-draft-card">
              <div className="panel-title">
                <div>
                  <div className="eyebrow">Draft</div>
                  <h2>{draft ? draft.spec.name ?? draft.name : "No draft selected"}</h2>
                  <p className="muted">Draft changes are saved explicitly, then published into immutable versions.</p>
                </div>
                <div className="actions-row">
                  <button className="button" type="button" disabled={isBusy || !draft} onClick={() => void saveDraft()}>Save draft</button>
                  <button className="button button--ghost" type="button" disabled={isBusy || !draft} onClick={() => void publishDraft()}>Publish</button>
                </div>
              </div>

              {!draft ? <EmptyState title="No draft selected" description="Select or create an agent to edit its draft." /> : (
                <>
                  <div className="agent-form-section">
                    <label>
                      Name
                      <input className="input" value={draft.spec.name ?? draft.name} onChange={(event) => updateSpec({ name: event.target.value })} />
                    </label>
                    <label>
                      Description
                      <textarea value={draft.spec.description ?? draft.description ?? ""} onChange={(event) => updateSpec({ description: event.target.value })} rows={3} />
                    </label>
                    <label>
                      Instructions
                      <textarea value={draft.spec.instructions ?? ""} onChange={(event) => updateSpec({ instructions: event.target.value })} rows={8} placeholder="Describe the agent's role, tone, constraints, and when it should use selected context." />
                    </label>
                  </div>

                  <div className="agent-form-grid">
                    <label>
                      Provider account
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
                    </label>
                    <label>
                      Model or deployment
                      {selectedProviderModels.length > 0 ? (
                        <select value={draft.spec.model ?? ""} onChange={(event) => updateSpec({ model: event.target.value || undefined })}>
                          <option value="">Select a synced model</option>
                          {selectedProviderModels.map((binding) => (
                            <option key={binding.id} value={binding.model}>{binding.display_name || binding.model}</option>
                          ))}
                        </select>
                      ) : (
                        <input className="input" aria-label="Agent model or deployment" value={draft.spec.model ?? ""} onChange={(event) => updateSpec({ model: event.target.value })} placeholder="gpt-4.1-mini or Azure deployment name" />
                      )}
                    </label>
                    <label>
                      Temperature
                      <input className="input" type="number" min="0" max="2" step="0.1" value={draft.spec.temperature ?? 0.7} onChange={(event) => updateSpec({ temperature: Number(event.target.value) })} />
                    </label>
                    <label>
                      Max output tokens
                      <input className="input" type="number" min="1" max="32000" step="1" value={draft.spec.maxOutputTokens ?? 1024} onChange={(event) => updateSpec({ maxOutputTokens: Number(event.target.value) })} />
                    </label>
                  </div>

                  <div className="agent-tool-grid">
                    <label className="agent-tool-card">
                      <input type="checkbox" checked={Boolean(draft.spec.tools?.knowledgeSearch)} onChange={(event) => updateTool("knowledgeSearch", event.target.checked)} />
                      <span><strong>Knowledge search</strong><small>Add selected snippets before the model call.</small></span>
                    </label>
                    <label className="agent-tool-card">
                      <input type="checkbox" checked={Boolean(draft.spec.tools?.calculator)} onChange={(event) => updateTool("calculator", event.target.checked)} />
                      <span><strong>Calculator</strong><small>Run simple arithmetic helpers.</small></span>
                    </label>
                    <label className="agent-tool-card">
                      <input type="checkbox" checked={Boolean(draft.spec.tools?.urlFetch)} onChange={(event) => updateTool("urlFetch", event.target.checked)} />
                      <span><strong>URL fetch</strong><small>Fetch public URLs as read-only context.</small></span>
                    </label>
                  </div>

                  <div className="agent-form-grid">
                    <label>
                      Knowledge result limit
                      <input className="input" type="number" min="1" max="10" value={draft.spec.knowledgeLimit ?? 5} onChange={(event) => updateSpec({ knowledgeLimit: Number(event.target.value) })} />
                    </label>
                    <div className="agent-form-section">
                      <h3>Attached knowledge</h3>
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
                </>
              )}
            </section>

            <section className="card agent-run-card">
              <div>
                <div className="eyebrow">Test run</div>
                <h2>Run published agent</h2>
              </div>
              {!draft ? <EmptyState title="No agent selected" description="Select an agent before running." /> : (
                <>
                  <label>
                    Input
                    <textarea aria-label="Agent run input" value={runInput} onChange={(event) => setRunInput(event.target.value)} rows={4} placeholder="Ask the agent to do something." />
                  </label>
                  <div className="actions-row">
                    <button className="button" type="button" disabled={isBusy} onClick={() => void runPublishedAgent()}>Run published version</button>
                    {runId ? <StatusBadge>{runStatus ?? "running"}</StatusBadge> : null}
                  </div>
                  {runId ? <p className="muted">Run {runId}</p> : null}
                  {runStatus === "running" ? <LoadingBlock title="Run is in progress" /> : null}
                  {runOutput ? <pre className="agent-trace__entry">{runOutput}</pre> : null}
                  {runSteps.length > 0 ? <h3>Steps</h3> : null}
                  <div className="agent-trace">
                    {runSteps.map((step) => (
                      <pre key={step.id} className="agent-trace__entry">{step.sequence_no}. {step.step_type} / {step.status}{"\n"}{JSON.stringify(step.output, null, 2)}</pre>
                    ))}
                  </div>
                  {runEvents.length > 0 ? <h3>Trace</h3> : null}
                  <div className="agent-trace">
                    {runEvents.map((event) => (
                      <pre key={event.id} className="agent-trace__entry">{event.sequence_no}. {event.event_type}{"\n"}{JSON.stringify(event.payload, null, 2)}</pre>
                    ))}
                  </div>
                </>
              )}
            </section>
          </main>
        </div>

        <p className={message.toLowerCase().includes("failed") || message.toLowerCase().includes("required") ? "error-state" : "notice"} role={message.toLowerCase().includes("failed") || message.toLowerCase().includes("required") ? "alert" : "status"} style={{ marginTop: 16 }}>{isBusy ? "Working... " : ""}{message}</p>
      </div>
    </div>
  );
}
