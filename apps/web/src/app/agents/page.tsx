"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ConfirmButton, LoadingBlock, StatusBadge, useToast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { getAccessToken } from "../../lib/auth-client";

const PINS_STORAGE_KEY = "packetchat.agents.pins";
const PENDING_AGENT_STORAGE_KEY = "packetchat.chat.pendingAgent";
const TEMPLATE_INSTRUCTIONS = `You are a helpful AI assistant.

Role:
- Describe the agent's persona and expertise here.

Tone:
- Be concise, professional, and friendly.

Constraints:
- Refuse to answer questions outside your scope.
- Never fabricate information; cite sources when possible.

When to use context:
- Reference attached knowledge bases when the user asks domain-specific questions.
`;
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "canceled", "completed", "errored"]);

type Agent = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  published_version_id: string | null;
  updated_at: string;
  access_role?: "viewer" | "runner" | "editor" | "owner" | string;
  is_owner?: boolean;
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
    maxContextTokens?: number;
    maxAgentSteps?: number;
    knowledgeBaseIds?: string[];
    knowledgeLimit?: number;
    fileContext?: {
      enabled?: boolean;
      knowledgeBaseIds?: string[];
      maxChars?: number;
    };
    artifacts?: {
      enabled?: boolean;
      customPromptMode?: boolean;
      instructions?: string;
    };
    openApiActions?: Array<{
      id?: string;
      name?: string;
      method?: string;
      url?: string;
      headers?: Record<string, string>;
      bodyTemplate?: string;
      enabled?: boolean;
    }>;
    agentChain?: {
      enabled?: boolean;
      agentIds?: string[];
      maxChildRuns?: number;
    };
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

type SortKey = "title" | "updated";
type ViewMode = "grid" | "list";

type ShareUser = {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
  status: string;
};

type AgentPermission = {
  subject_user_id: string;
  role: "viewer" | "runner" | "editor" | "owner";
  email: string;
  display_name: string | null;
};

const SHARE_ROLES = [
  { value: "none", label: "No access" },
  { value: "viewer", label: "Viewer" },
  { value: "runner", label: "Runner" },
  { value: "editor", label: "Editor" },
  { value: "owner", label: "Owner" }
] as const;

const AVATAR_TINTS = ["#4b8ad6", "#d97757", "#1fb8cd", "#10a37f", "#7c3aed", "#c49a3a", "#79b57a"];

function avatarTint(agentId: string) {
  let hash = 0;
  for (let i = 0; i < agentId.length; i += 1) hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[hash % AVATAR_TINTS.length];
}

function avatarInitial(name: string) {
  const trimmed = name.trim();
  return trimmed ? trimmed[0].toUpperCase() : "A";
}

function authHeaders() {
  const token = getAccessToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export default function AgentsPage() {
  const toast = useToast();
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("title");
  const [view, setView] = useState<ViewMode>("grid");
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [providerAccounts, setProviderAccounts] = useState<ProviderAccount[]>([]);
  const [modelBindings, setModelBindings] = useState<ModelBinding[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newInstructions, setNewInstructions] = useState("");
  const [createMenuOpen, setCreateMenuOpen] = useState(false);

  const [runInput, setRunInput] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [runOutput, setRunOutput] = useState("");
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const [runSteps, setRunSteps] = useState<RunStep[]>([]);
  const [shareTarget, setShareTarget] = useState<Agent | null>(null);
  const [shareUsers, setShareUsers] = useState<ShareUser[]>([]);
  const [sharePermissions, setSharePermissions] = useState<AgentPermission[]>([]);
  const [shareLoading, setShareLoading] = useState(false);

  const editorRef = useRef<HTMLDialogElement | null>(null);
  const createRef = useRef<HTMLDialogElement | null>(null);
  const shareRef = useRef<HTMLDialogElement | null>(null);
  const editorOpenRef = useRef(false);
  const pollAbortRef = useRef<{ cancelled: boolean } | null>(null);
  const createMenuRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return agents;
    return agents.filter((agent) =>
      [agent.name, agent.description].some((value) => (value ?? "").toLowerCase().includes(needle))
    );
  }, [agents, query]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    if (sort === "title") copy.sort((a, b) => a.name.localeCompare(b.name));
    if (sort === "updated") copy.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    return copy;
  }, [filtered, sort]);

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    const token = authHeaders().authorization;
    if (token) headers.set("authorization", token);
    if (init?.body) headers.set("content-type", "application/json");

    const response = await fetch(path, { ...init, headers });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error?.message ?? "Request failed");
    return data as T;
  }

  async function loadAgents() {
    setIsBusy(true);
    try {
      const data = await request<{ agents: Agent[] }>("/api/agents");
      setAgents(data.agents);
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      setMessage(nextError);
      toast({ title: "Unable to load agents", message: nextError, variant: "error" });
    } finally {
      setIsBusy(false);
      setLoading(false);
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

  useEffect(() => {
    loadAgents();
    loadProviders();
    loadKnowledgeBases();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(PINS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setFavorites(new Set(parsed.filter((value): value is string => typeof value === "string")));
      }
    } catch {
      // ignore malformed storage
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(Array.from(favorites)));
    } catch {
      // ignore quota/serialization errors
    }
  }, [favorites]);

  useEffect(() => {
    if (!createMenuOpen) return;
    function onDocumentClick(event: MouseEvent) {
      if (!createMenuRef.current) return;
      if (!createMenuRef.current.contains(event.target as Node)) setCreateMenuOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setCreateMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocumentClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [createMenuOpen]);

  useEffect(() => {
    return () => {
      if (pollAbortRef.current) pollAbortRef.current.cancelled = true;
    };
  }, []);

  async function loadDraft(agentId: string) {
    setIsBusy(true);
    try {
      const data = await request<{ draft: Draft }>(`/api/agents/${agentId}/draft`);
      setDraft(data.draft);
      setRunId(null);
      setRunStatus(null);
      setRunOutput("");
      setRunEvents([]);
      setRunSteps([]);
      setRunInput("");
    } catch (error) {
      setDraft(null);
      const nextError = error instanceof Error ? error.message : String(error);
      toast({ title: "Unable to load draft", message: nextError, variant: "error" });
    } finally {
      setIsBusy(false);
    }
  }

  function openEditor(agent: Agent) {
    void loadDraft(agent.id).then(() => {
      editorOpenRef.current = true;
      editorRef.current?.showModal();
    });
  }

  function closeEditor() {
    editorOpenRef.current = false;
    if (pollAbortRef.current) pollAbortRef.current.cancelled = true;
    editorRef.current?.close();
    setDraft(null);
  }

  function openCreate(prefill?: { instructions?: string }) {
    setCreateMenuOpen(false);
    setNewName("");
    setNewDescription("");
    setNewInstructions(prefill?.instructions ?? "");
    createRef.current?.showModal();
  }

  function closeCreate() {
    createRef.current?.close();
  }

  async function createAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) {
      toast({ message: "Name is required.", variant: "warning" });
      return;
    }
    const instructions = newInstructions;
    setIsBusy(true);
    try {
      const data = await request<{ agentId: string }>("/api/agents", {
        method: "POST",
        body: JSON.stringify({ name, description: newDescription })
      });
      if (instructions.trim().length > 0) {
        try {
          await request(`/api/agents/${data.agentId}/draft`, {
            method: "PATCH",
            body: JSON.stringify({ spec: { name, description: newDescription, instructions } })
          });
        } catch {
          // non-fatal: editor still opens for manual edits
        }
      }
      setNewName("");
      setNewDescription("");
      setNewInstructions("");
      closeCreate();
      await loadAgents();
      const created = await request<{ agent: Agent }>(`/api/agents/${data.agentId}`).catch(() => null);
      if (created?.agent) openEditor(created.agent);
      toast({ message: "Agent created.", variant: "success" });
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
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
        maxContextTokens: typeof draft.spec.maxContextTokens === "number" ? draft.spec.maxContextTokens : undefined,
        maxAgentSteps: typeof draft.spec.maxAgentSteps === "number" ? draft.spec.maxAgentSteps : undefined,
        knowledgeBaseIds: draft.spec.knowledgeBaseIds ?? [],
        knowledgeLimit: draft.spec.knowledgeLimit ?? 5,
        fileContext: {
          enabled: Boolean(draft.spec.fileContext?.enabled),
          knowledgeBaseIds: draft.spec.fileContext?.knowledgeBaseIds ?? [],
          maxChars: draft.spec.fileContext?.maxChars ?? 12000
        },
        artifacts: {
          enabled: Boolean(draft.spec.artifacts?.enabled),
          customPromptMode: Boolean(draft.spec.artifacts?.customPromptMode),
          instructions: draft.spec.artifacts?.instructions ?? ""
        },
        openApiActions: draft.spec.openApiActions ?? [],
        agentChain: {
          enabled: Boolean(draft.spec.agentChain?.enabled),
          agentIds: draft.spec.agentChain?.agentIds ?? [],
          maxChildRuns: draft.spec.agentChain?.maxChildRuns ?? 3
        },
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
      toast({ message: "Draft saved.", variant: "success" });
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
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
      toast({ message: `Published version ${data.version.version_number}.`, variant: "success" });
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      toast({ title: "Unable to publish draft", message: nextError, variant: "error" });
    } finally {
      setIsBusy(false);
    }
  }

  async function deleteAgent(agent: Agent, options?: { skipConfirm?: boolean }) {
    if (!options?.skipConfirm && !window.confirm(`Delete ${agent.name}?`)) return;
    setIsBusy(true);
    try {
      await request(`/api/agents/${agent.id}`, { method: "DELETE" });
      setAgents((current) => current.filter((item) => item.id !== agent.id));
      setFavorites((current) => {
        if (!current.has(agent.id)) return current;
        const next = new Set(current);
        next.delete(agent.id);
        return next;
      });
      if (draft?.agent_id === agent.id || editorOpenRef.current) closeEditor();
      toast({ message: "Agent deleted.", variant: "success" });
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      toast({ title: "Unable to delete agent", message: nextError, variant: "error" });
    } finally {
      setIsBusy(false);
    }
  }

  async function shareAgent(agent: Agent) {
    setShareTarget(agent);
    setShareLoading(true);
    try {
      const data = await request<{ users: ShareUser[]; permissions: AgentPermission[] }>(`/api/agents/${agent.id}/permissions`);
      setShareUsers(data.users);
      setSharePermissions(data.permissions);
      shareRef.current?.showModal();
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      toast({ title: "Unable to open sharing", message: nextError, variant: "error" });
    } finally {
      setShareLoading(false);
    }
  }

  async function updateShare(userId: string, role: string) {
    if (!shareTarget) return;
    setShareLoading(true);
    try {
      const data = await request<{ permissions: AgentPermission[] }>(`/api/agents/${shareTarget.id}/permissions`, {
        method: "PATCH",
        body: JSON.stringify({ permissions: [{ userId, role }] })
      });
      setSharePermissions(data.permissions);
      toast({ message: "Sharing updated.", variant: "success" });
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      toast({ title: "Unable to update sharing", message: nextError, variant: "error" });
    } finally {
      setShareLoading(false);
    }
  }

  function closeShare() {
    shareRef.current?.close();
    setShareTarget(null);
    setShareUsers([]);
    setSharePermissions([]);
  }

  function startChat(agent: Agent) {
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(PENDING_AGENT_STORAGE_KEY, agent.id);
      } catch {
        // ignore storage errors
      }
    }
  }

  async function duplicateAgent(agent: Agent) {
    setIsBusy(true);
    try {
      await request<{ agentId: string }>("/api/agents", {
        method: "POST",
        body: JSON.stringify({ name: `Copy of ${agent.name}`, description: agent.description ?? "" })
      });
      await loadAgents();
      toast({ message: `Duplicated ${agent.name}.`, variant: "success" });
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      toast({ title: "Unable to duplicate agent", message: nextError, variant: "error" });
    } finally {
      setIsBusy(false);
    }
  }

  function toggleFavorite(id: string) {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function fetchRun(agentId: string, nextRunId: string) {
    const data = await request<{ run: { status: string; error_message: string | null }; steps: RunStep[]; events: RunEvent[] }>(
      `/api/agents/${agentId}/runs/${nextRunId}`
    );
    setRunStatus(data.run.status);
    setRunEvents(data.events);
    setRunSteps(data.steps);
    const completed = data.events.find((event) => event.event_type === "run.completed");
    const outputText = completed?.payload?.outputText;
    if (typeof outputText === "string") setRunOutput(outputText);
    return data.run.status;
  }

  async function pollRunUntilDone(agentId: string, nextRunId: string, token: { cancelled: boolean }) {
    const initialStatus = await fetchRun(agentId, nextRunId);
    if (TERMINAL_RUN_STATUSES.has(initialStatus)) return initialStatus;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (token.cancelled || !editorOpenRef.current) return null;
      try {
        const status = await fetchRun(agentId, nextRunId);
        if (TERMINAL_RUN_STATUSES.has(status)) return status;
      } catch {
        // keep polling on transient failures
      }
    }
    return null;
  }

  async function runAgent() {
    if (!draft) return;
    const inputText = runInput.trim();
    if (!inputText) {
      toast({ message: "Run input is required.", variant: "warning" });
      return;
    }
    setIsBusy(true);
    setRunId(null);
    setRunStatus("running");
    setRunOutput("");
    setRunEvents([]);
    setRunSteps([]);
    if (pollAbortRef.current) pollAbortRef.current.cancelled = true;
    const token = { cancelled: false };
    pollAbortRef.current = token;
    const agentId = draft.agent_id;
    try {
      const data = await request<{ runId: string; status: string; outputText?: string; error?: string }>(
        `/api/agents/${agentId}/runs`,
        { method: "POST", body: JSON.stringify({ inputText }) }
      );
      setRunId(data.runId);
      setRunStatus(data.status);
      setRunOutput(data.outputText ?? "");
      const finalStatus = TERMINAL_RUN_STATUSES.has(data.status)
        ? data.status
        : await pollRunUntilDone(agentId, data.runId, token);
      if (token.cancelled || !editorOpenRef.current) return;
      const status = finalStatus ?? data.status;
      const isError = Boolean(data.error) || status === "failed" || status === "errored";
      toast({ message: data.error ?? `Run ${status}.`, variant: isError ? "error" : "success" });
    } catch (error) {
      if (!token.cancelled) setRunStatus("failed");
      const nextError = error instanceof Error ? error.message : String(error);
      if (!token.cancelled) toast({ title: "Agent run failed", message: nextError, variant: "error" });
    } finally {
      setIsBusy(false);
    }
  }

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
    setDraft({ ...draft, spec: { ...draft.spec, knowledgeBaseIds: next } });
  }

  function toggleFileContextKnowledgeBase(knowledgeBaseId: string, enabled: boolean) {
    if (!draft) return;
    const current = draft.spec.fileContext?.knowledgeBaseIds ?? [];
    const next = enabled ? [...new Set([...current, knowledgeBaseId])] : current.filter((id) => id !== knowledgeBaseId);
    setDraft({
      ...draft,
      spec: {
        ...draft.spec,
        fileContext: {
          ...draft.spec.fileContext,
          enabled: draft.spec.fileContext?.enabled ?? next.length > 0,
          knowledgeBaseIds: next
        }
      }
    });
  }

  function addOpenApiAction() {
    if (!draft) return;
    const current = draft.spec.openApiActions ?? [];
    setDraft({
      ...draft,
      spec: {
        ...draft.spec,
        openApiActions: [
          ...current,
          { id: `action-${Date.now()}`, name: "New action", method: "GET", url: "https://api.example.com/resource?query={{inputEncoded}}", headers: {}, bodyTemplate: "", enabled: true }
        ]
      }
    });
  }

  function updateOpenApiAction(index: number, patch: Partial<NonNullable<Draft["spec"]["openApiActions"]>[number]>) {
    if (!draft) return;
    const current = draft.spec.openApiActions ?? [];
    const next = current.map((action, actionIndex) => (actionIndex === index ? { ...action, ...patch } : action));
    setDraft({ ...draft, spec: { ...draft.spec, openApiActions: next } });
  }

  function removeOpenApiAction(index: number) {
    if (!draft) return;
    const next = (draft.spec.openApiActions ?? []).filter((_, actionIndex) => actionIndex !== index);
    setDraft({ ...draft, spec: { ...draft.spec, openApiActions: next } });
  }

  function updateOpenApiHeader(actionIndex: number, raw: string) {
    try {
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        updateOpenApiAction(actionIndex, { headers: parsed as Record<string, string> });
        return;
      }
      toast({ message: "Headers must be a JSON object.", variant: "warning" });
    } catch {
      toast({ message: "Headers must be valid JSON.", variant: "warning" });
    }
  }

  function toggleChainAgent(agentId: string, enabled: boolean) {
    if (!draft) return;
    const current = draft.spec.agentChain?.agentIds ?? [];
    const next = enabled ? [...new Set([...current, agentId])] : current.filter((id) => id !== agentId);
    setDraft({
      ...draft,
      spec: {
        ...draft.spec,
        agentChain: {
          ...draft.spec.agentChain,
          enabled: draft.spec.agentChain?.enabled ?? next.length > 0,
          agentIds: next
        }
      }
    });
  }

  const selectedProviderModels = draft?.spec.providerAccountId
    ? modelBindings.filter((binding) => binding.provider_account_id === draft.spec.providerAccountId)
    : [];

  return (
    <section className="agents-lib">
      <header className="agents-lib__head">
        <div className="agents-lib__heading">
          <h1>Agents</h1>
          <p className="sub">Agents are pre-built AI assistants for specific tasks.</p>
        </div>
        <div className="agents-lib__head-actions">
          <label className="agents-lib__search">
            <Icon.search />
            <input
              placeholder="Search AI agents..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search agents"
            />
          </label>
          <div className="agents-lib__create" ref={createMenuRef} style={{ position: "relative" }}>
            <button className="button button--primary" type="button" onClick={() => openCreate()}>Create AI agent</button>
            <button
              className="button button--primary agents-lib__create-chev"
              type="button"
              onClick={() => setCreateMenuOpen((open) => !open)}
              aria-label="Create menu"
              aria-haspopup="menu"
              aria-expanded={createMenuOpen}
              title="Create options"
            >
              <Icon.chev />
            </button>
            {createMenuOpen ? (
              <div
                role="menu"
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  right: 0,
                  minWidth: 200,
                  background: "var(--surface-1, #fff)",
                  color: "var(--text-1, #111)",
                  border: "1px solid var(--border-1, rgba(0,0,0,0.12))",
                  borderRadius: 8,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.16)",
                  padding: 4,
                  zIndex: 50
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => openCreate()}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "8px 10px",
                    background: "transparent",
                    border: 0,
                    borderRadius: 6,
                    cursor: "pointer",
                    color: "inherit",
                    font: "inherit"
                  }}
                >
                  Start from scratch
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => openCreate({ instructions: TEMPLATE_INSTRUCTIONS })}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "8px 10px",
                    background: "transparent",
                    border: 0,
                    borderRadius: 6,
                    cursor: "pointer",
                    color: "inherit",
                    font: "inherit"
                  }}
                >
                  Start from template
                </button>
              </div>
            ) : null}
          </div>
          <button
            className="button button--white"
            type="button"
            onClick={() => router.push("/plugins/marketplace")}
          >
            Browse agents
          </button>
        </div>
      </header>

      <div className="agents-lib__layout">
        <aside className="agents-lib__rail" aria-label="Categories">
          <button className="agents-lib__rail-item on" type="button">Uncategorized</button>
        </aside>

        <main className="agents-lib__main">
          <div className="agents-lib__toolbar-row">
            <h2>Uncategorized</h2>
            <div className="agents-lib__controls">
              <div className="prompt-lib__view" role="group" aria-label="View mode">
                <button
                  type="button"
                  className={`ib ${view === "list" ? "on" : ""}`}
                  onClick={() => setView("list")}
                  aria-pressed={view === "list"}
                  aria-label="List view"
                  title="List view"
                >
                  <Icon.list />
                </button>
                <button
                  type="button"
                  className={`ib ${view === "grid" ? "on" : ""}`}
                  onClick={() => setView("grid")}
                  aria-pressed={view === "grid"}
                  aria-label="Grid view"
                  title="Grid view"
                >
                  <Icon.grid />
                </button>
              </div>
              <label className="prompt-lib__select prompt-lib__select--sm">
                <Icon.sortDesc />
                <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} aria-label="Sort agents">
                  <option value="title">Title</option>
                  <option value="updated">Recently updated</option>
                </select>
                <Icon.chev />
              </label>
            </div>
          </div>

          {loading ? <LoadingBlock title="Loading agents" /> : null}
          {!loading && sorted.length === 0 ? (
            <div className="empty-state">
              {agents.length === 0
                ? "No agents yet. Click Create AI agent to build your first one."
                : "No agents match your search."}
            </div>
          ) : null}

          <div className={view === "grid" ? "agents-lib__grid" : "agents-lib__list"}>
            {sorted.map((agent) => {
              const favored = favorites.has(agent.id);
              return (
                <article className="agent-card" key={agent.id}>
                  <div className="agent-card__head">
                    <div className="agent-card__avatar" style={{ background: avatarTint(agent.id) }} aria-hidden="true">
                      {avatarInitial(agent.name)}
                    </div>
                    <div className="agent-card__title-wrap">
                      <div className="agent-card__title">{agent.name}</div>
                      {agent.description ? <div className="agent-card__desc">{agent.description}</div> : null}
                    </div>
                  </div>
                  <div className="agent-card__footer">
                    <div className="agent-card__actions">
                      <button
                        className="ib"
                        type="button"
                        onClick={() => void duplicateAgent(agent)}
                        aria-label="Duplicate agent"
                        title="Duplicate"
                        disabled={isBusy}
                      >
                        <Icon.copy />
                      </button>
                      <button
                        className="ib"
                        type="button"
                        onClick={() => openEditor(agent)}
                        aria-label="Edit agent"
                        title="Edit"
                      >
                        <Icon.edit />
                      </button>
                      <button
                        className="ib"
                        type="button"
                        onClick={() => void shareAgent(agent)}
                        aria-label="Share agent"
                        title="Share"
                      >
                        <Icon.share />
                      </button>
                      <button
                        className="ib"
                        type="button"
                        onClick={() => void deleteAgent(agent)}
                        aria-label="Delete agent"
                        title="Delete"
                        disabled={isBusy}
                      >
                        <Icon.trash />
                      </button>
                      <button
                        className={`ib ${favored ? "on" : ""}`}
                        type="button"
                        onClick={() => toggleFavorite(agent.id)}
                        aria-pressed={favored}
                        aria-label={favored ? "Unpin agent" : "Pin agent"}
                        title={favored ? "Unpin" : "Pin"}
                      >
                        <Icon.pin />
                      </button>
                    </div>
                    <Link
                      className="prompt-card__use"
                      href={`/chat?agent=${encodeURIComponent(agent.id)}`}
                      onClick={() => startChat(agent)}
                    >
                      Chat now
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        </main>
      </div>

      <dialog ref={createRef} className="prompt-dialog agents-create-dialog" onClose={closeCreate} aria-label="Create AI agent">
        <form className="prompt-dialog__form" onSubmit={(event) => void createAgent(event)}>
          <header className="prompt-dialog__head">
            <h2>Create AI agent</h2>
            <button className="ib" type="button" onClick={closeCreate} aria-label="Close" title="Close">
              <Icon.plus style={{ transform: "rotate(45deg)" }} />
            </button>
          </header>
          <label>
            Name
            <input className="input" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Support triage" required />
          </label>
          <label>
            Description
            <textarea value={newDescription} onChange={(event) => setNewDescription(event.target.value)} rows={3} />
          </label>
          <label>
            Instructions
            <textarea
              value={newInstructions}
              onChange={(event) => setNewInstructions(event.target.value)}
              rows={6}
              placeholder="Optional. Describe the agent's role, tone, and when to use context."
            />
          </label>
          <div className="prompt-dialog__actions">
            <button className="button button--ghost" type="button" onClick={closeCreate}>Cancel</button>
            <button className="button button--primary" type="submit" disabled={isBusy}>Create agent</button>
          </div>
        </form>
      </dialog>

      <dialog ref={editorRef} className="prompt-dialog agent-editor" onClose={closeEditor} aria-label="Edit agent">
        <form
          className="prompt-dialog__form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveDraft();
          }}
        >
          <header className="prompt-dialog__head">
            <h2>{draft ? draft.spec.name ?? draft.name : "Agent"}</h2>
            <div className="cluster">
              {draft ? <StatusBadge>{draft.status}</StatusBadge> : null}
              {draft ? <span className="muted" style={{ fontSize: 12 }}>rev {draft.revision}</span> : null}
              <button className="ib" type="button" onClick={closeEditor} aria-label="Close" title="Close">
                <Icon.plus style={{ transform: "rotate(45deg)" }} />
              </button>
            </div>
          </header>

          {!draft ? (
            <LoadingBlock title="Loading draft" />
          ) : (
            <>
              <div className="agent-editor__grid">
                <label>
                  Name
                  <input className="input" value={draft.spec.name ?? draft.name} onChange={(event) => updateSpec({ name: event.target.value })} />
                </label>
                <label>
                  Description
                  <input
                    className="input"
                    value={draft.spec.description ?? draft.description ?? ""}
                    onChange={(event) => updateSpec({ description: event.target.value })}
                  />
                </label>
              </div>

              <label>
                Instructions
                <textarea
                  value={draft.spec.instructions ?? ""}
                  onChange={(event) => updateSpec({ instructions: event.target.value })}
                  rows={6}
                  placeholder="Describe the agent's role, tone, constraints, and when to use context."
                />
              </label>

              <div className="agent-editor__grid">
                <label>
                  Provider account
                  <select
                    value={draft.spec.providerAccountId ?? ""}
                    onChange={(event) => {
                      const account = providerAccounts.find((item) => item.id === event.target.value);
                      updateSpec({
                        providerAccountId: event.target.value || undefined,
                        provider: account?.provider,
                        model: undefined
                      });
                    }}
                  >
                    <option value="">Select a provider account</option>
                    {providerAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.display_name} ({account.provider})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Model
                  {selectedProviderModels.length > 0 ? (
                    <select value={draft.spec.model ?? ""} onChange={(event) => updateSpec({ model: event.target.value || undefined })}>
                      <option value="">Select a model</option>
                      {selectedProviderModels.map((binding) => (
                        <option key={binding.id} value={binding.model}>{binding.display_name || binding.model}</option>
                      ))}
                    </select>
                  ) : (
                    <input className="input" value={draft.spec.model ?? ""} onChange={(event) => updateSpec({ model: event.target.value })} placeholder="gpt-4.1-mini, claude-3-5-sonnet-latest" />
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
                <label>
                  Max context tokens
                  <input className="input" type="number" min="1000" max="200000" step="1000" value={draft.spec.maxContextTokens ?? 8000} onChange={(event) => updateSpec({ maxContextTokens: Number(event.target.value) })} />
                </label>
                <label>
                  Max agent steps
                  <input className="input" type="number" min="1" max="25" step="1" value={draft.spec.maxAgentSteps ?? 4} onChange={(event) => updateSpec({ maxAgentSteps: Number(event.target.value) })} />
                </label>
              </div>

              {providerAccounts.length === 0 ? (
                <p className="warning">
                  Configure a provider key in <Link className="link-button" href="/providers">Providers</Link> before running this agent.
                </p>
              ) : null}

              <div>
                <div className="eyebrow" style={{ margin: "8px 0 6px" }}>Capabilities and tools</div>
                <div className="agent-tool-grid">
                  <label className="agent-tool-card">
                    <input type="checkbox" checked={Boolean(draft.spec.tools?.knowledgeSearch)} onChange={(event) => updateTool("knowledgeSearch", event.target.checked)} />
                    <span><strong>File search</strong><small>RAG over selected knowledge bases before the model call.</small></span>
                  </label>
                  <label className="agent-tool-card">
                    <input
                      type="checkbox"
                      checked={Boolean(draft.spec.fileContext?.enabled)}
                      onChange={(event) => updateSpec({ fileContext: { ...draft.spec.fileContext, enabled: event.target.checked } })}
                    />
                    <span><strong>File context</strong><small>Inject extracted document text into the agent context.</small></span>
                  </label>
                  <label className="agent-tool-card">
                    <input
                      type="checkbox"
                      checked={Boolean(draft.spec.artifacts?.enabled)}
                      onChange={(event) => updateSpec({ artifacts: { ...draft.spec.artifacts, enabled: event.target.checked } })}
                    />
                    <span><strong>Artifacts</strong><small>Add artifact-format instructions for HTML, Mermaid, React, or SVG output.</small></span>
                  </label>
                  <label className="agent-tool-card">
                    <input type="checkbox" checked={Boolean(draft.spec.tools?.calculator)} onChange={(event) => updateTool("calculator", event.target.checked)} />
                    <span><strong>Calculator</strong><small>Deterministic arithmetic helper.</small></span>
                  </label>
                  <label className="agent-tool-card">
                    <input type="checkbox" checked={Boolean(draft.spec.tools?.urlFetch)} onChange={(event) => updateTool("urlFetch", event.target.checked)} />
                    <span><strong>URL fetch</strong><small>Fetch public URLs as read-only context.</small></span>
                  </label>
                  <label className="agent-tool-card">
                    <input
                      type="checkbox"
                      checked={Boolean(draft.spec.openApiActions?.some((action) => action.enabled !== false))}
                      onChange={(event) => {
                        const current = draft.spec.openApiActions ?? [];
                        if (current.length === 0 && event.target.checked) addOpenApiAction();
                        else updateSpec({ openApiActions: current.map((action) => ({ ...action, enabled: event.target.checked })) });
                      }}
                    />
                    <span><strong>OpenAPI actions</strong><small>Call configured HTTP actions during agent runs.</small></span>
                  </label>
                  <label className="agent-tool-card">
                    <input
                      type="checkbox"
                      checked={Boolean(draft.spec.agentChain?.enabled)}
                      onChange={(event) => updateSpec({ agentChain: { ...draft.spec.agentChain, enabled: event.target.checked } })}
                    />
                    <span><strong>Agent chain</strong><small>Run selected child agents as pre-run context.</small></span>
                  </label>
                  {["Code interpreter", "MCP tools"].map((label) => (
                    <label className="agent-tool-card" key={label} aria-disabled="true">
                      <input type="checkbox" disabled />
                      <span><strong>{label}</strong><small>Runtime integration not configured in this release.</small></span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <div className="eyebrow" style={{ margin: "8px 0 6px" }}>OpenAPI actions</div>
                {(draft.spec.openApiActions ?? []).map((action, index) => (
                  <div className="agent-tool-card" key={action.id ?? index} style={{ display: "grid", gap: 8 }}>
                    <label className="checkbox-row">
                      <input type="checkbox" checked={action.enabled !== false} onChange={(event) => updateOpenApiAction(index, { enabled: event.target.checked })} />
                      Enabled
                    </label>
                    <div className="agent-editor__grid">
                      <label>
                        Name
                        <input className="input" value={action.name ?? ""} onChange={(event) => updateOpenApiAction(index, { name: event.target.value })} />
                      </label>
                      <label>
                        Method
                        <select value={action.method ?? "GET"} onChange={(event) => updateOpenApiAction(index, { method: event.target.value })}>
                          {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => <option key={method} value={method}>{method}</option>)}
                        </select>
                      </label>
                    </div>
                    <label>
                      URL
                      <input className="input" value={action.url ?? ""} onChange={(event) => updateOpenApiAction(index, { url: event.target.value })} placeholder="https://api.example.com/tickets?query={{inputEncoded}}" />
                    </label>
                    <label>
                      Headers JSON
                      <textarea
                        key={`${action.id ?? index}-${JSON.stringify(action.headers ?? {})}`}
                        defaultValue={JSON.stringify(action.headers ?? {}, null, 2)}
                        onBlur={(event) => updateOpenApiHeader(index, event.target.value)}
                        rows={3}
                      />
                    </label>
                    <label>
                      Body template
                      <textarea value={action.bodyTemplate ?? ""} onChange={(event) => updateOpenApiAction(index, { bodyTemplate: event.target.value })} rows={3} placeholder='{"query":"{{input}}"}' />
                    </label>
                    <button className="button button--ghost" type="button" onClick={() => removeOpenApiAction(index)}>Remove action</button>
                  </div>
                ))}
                <button className="button button--ghost" type="button" onClick={addOpenApiAction}>Add action</button>
              </div>

              <div>
                <div className="eyebrow" style={{ margin: "8px 0 6px" }}>Agent chain</div>
                <label>
                  Max child runs
                  <input
                    className="input"
                    type="number"
                    min="1"
                    max="5"
                    step="1"
                    value={draft.spec.agentChain?.maxChildRuns ?? 3}
                    onChange={(event) => updateSpec({ agentChain: { ...draft.spec.agentChain, maxChildRuns: Number(event.target.value) } })}
                  />
                </label>
                <div className="checkbox-list" style={{ marginTop: 8 }}>
                  {agents.filter((agent) => agent.id !== draft.agent_id && agent.published_version_id).map((agent) => (
                    <label key={agent.id} className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={(draft.spec.agentChain?.agentIds ?? []).includes(agent.id)}
                        onChange={(event) => toggleChainAgent(agent.id, event.target.checked)}
                      />
                      {agent.name}
                    </label>
                  ))}
                </div>
              </div>

              {knowledgeBases.length > 0 ? (
                <div>
                  <div className="eyebrow" style={{ margin: "8px 0 6px" }}>File search knowledge</div>
                  <div className="checkbox-list">
                    {knowledgeBases.map((kb) => (
                      <label key={kb.id} className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={(draft.spec.knowledgeBaseIds ?? []).includes(kb.id)}
                          onChange={(event) => toggleKnowledgeBase(kb.id, event.target.checked)}
                        />
                        {kb.name} ({kb.document_count} docs)
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}

              {knowledgeBases.length > 0 ? (
                <div>
                  <div className="eyebrow" style={{ margin: "8px 0 6px" }}>File context knowledge</div>
                  <div className="checkbox-list">
                    {knowledgeBases.map((kb) => (
                      <label key={kb.id} className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={(draft.spec.fileContext?.knowledgeBaseIds ?? []).includes(kb.id)}
                          onChange={(event) => toggleFileContextKnowledgeBase(kb.id, event.target.checked)}
                        />
                        {kb.name} ({kb.document_count} docs)
                      </label>
                    ))}
                  </div>
                  <label style={{ marginTop: 8 }}>
                    File context character budget
                    <input
                      className="input"
                      type="number"
                      min="1000"
                      max="50000"
                      step="1000"
                      value={draft.spec.fileContext?.maxChars ?? 12000}
                      onChange={(event) => updateSpec({ fileContext: { ...draft.spec.fileContext, maxChars: Number(event.target.value) } })}
                    />
                  </label>
                </div>
              ) : null}

              <div>
                <div className="eyebrow" style={{ margin: "8px 0 6px" }}>Artifact instructions</div>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={Boolean(draft.spec.artifacts?.customPromptMode)}
                    onChange={(event) => updateSpec({ artifacts: { ...draft.spec.artifacts, customPromptMode: event.target.checked } })}
                  />
                  Use custom artifact prompt only
                </label>
                <textarea
                  value={draft.spec.artifacts?.instructions ?? ""}
                  onChange={(event) => updateSpec({ artifacts: { ...draft.spec.artifacts, instructions: event.target.value } })}
                  rows={4}
                  placeholder="Optional artifact-specific instructions."
                />
              </div>

              <details className="agent-editor__test">
                <summary>Test run</summary>
                <div className="agent-editor__test-body">
                  <label>
                    Input
                    <textarea value={runInput} onChange={(event) => setRunInput(event.target.value)} rows={3} placeholder="Ask the agent to do something." />
                  </label>
                  <div className="cluster">
                    <button className="button button--ghost" type="button" disabled={isBusy} onClick={() => void runAgent()}>Run published version</button>
                    {runId ? <StatusBadge>{runStatus ?? "running"}</StatusBadge> : null}
                  </div>
                  {runStatus === "running" ? <LoadingBlock title="Run is in progress" /> : null}
                  {runOutput ? <pre className="agent-trace__entry">{runOutput}</pre> : null}
                  {runSteps.length > 0 ? (
                    <div className="agent-trace">
                      {runSteps.map((step) => (
                        <pre key={step.id} className="agent-trace__entry">{step.sequence_no}. {step.step_type} / {step.status}</pre>
                      ))}
                    </div>
                  ) : null}
                </div>
              </details>

              <div className="prompt-dialog__actions">
                <ConfirmButton
                  className="button button--danger"
                  message={`Delete ${draft.spec.name ?? draft.name}?`}
                  confirmLabel="Delete"
                  onConfirm={() => {
                    const current =
                      agents.find((agent) => agent.id === draft.agent_id) ??
                      ({
                        id: draft.agent_id,
                        name: draft.spec.name ?? draft.name,
                        description: draft.spec.description ?? draft.description ?? null,
                        status: draft.status,
                        published_version_id: null,
                        updated_at: ""
                      } as Agent);
                    void deleteAgent(current, { skipConfirm: true });
                  }}
                >
                  Delete
                </ConfirmButton>
                <div style={{ flex: 1 }} />
                <button className="button button--ghost" type="button" disabled={isBusy} onClick={() => void publishDraft()}>Publish</button>
                <button className="button button--primary" type="submit" disabled={isBusy}>Save draft</button>
              </div>
            </>
          )}
        </form>
      </dialog>

      <dialog ref={shareRef} className="prompt-dialog agent-editor" onClose={closeShare} aria-label="Share agent">
        <form
          className="prompt-dialog__form"
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          <header className="prompt-dialog__head">
            <h2>Share {shareTarget?.name ?? "agent"}</h2>
            <button className="ib" type="button" onClick={closeShare} aria-label="Close" title="Close">
              <Icon.plus style={{ transform: "rotate(45deg)" }} />
            </button>
          </header>
          <p className="muted" style={{ margin: 0 }}>
            Grant Viewer to use the agent, Runner to run it from API/chat surfaces, Editor to modify the builder, or Owner to re-share and administer it.
          </p>
          <div className="checkbox-list">
            {shareUsers.map((user) => {
              const current = sharePermissions.find((permission) => permission.subject_user_id === user.id)?.role ?? "none";
              return (
                <label key={user.id} className="checkbox-row" style={{ justifyContent: "space-between", gap: 12 }}>
                  <span>
                    {user.display_name || user.email}
                    <span className="muted" style={{ display: "block", fontSize: 12 }}>{user.email}</span>
                  </span>
                  <select
                    value={current}
                    disabled={shareLoading}
                    onChange={(event) => void updateShare(user.id, event.target.value)}
                    aria-label={`Access for ${user.email}`}
                    style={{ maxWidth: 160 }}
                  >
                    {SHARE_ROLES.map((role) => (
                      <option key={role.value} value={role.value}>{role.label}</option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>
          {shareUsers.length === 0 ? <div className="empty-state">No active users available to share with.</div> : null}
          <div className="prompt-dialog__actions">
            <button className="button button--primary" type="button" onClick={closeShare}>Done</button>
          </div>
        </form>
      </dialog>

      {message ? <p className="sr-only" aria-live="polite">{message}</p> : null}
    </section>
  );
}
