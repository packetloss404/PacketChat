import type { ProviderId } from "@packetchat/contracts";
import { authFetch } from "./auth-client";

type ApiError = {
  error?: {
    message?: string;
  } | string;
};

type JsonBody = Record<string, unknown> | unknown[];

export type AuthUser = {
  id: string;
  email: string;
  displayName?: string | null;
  role?: "admin" | "user" | string;
  status?: string;
  byokEnabled?: boolean;
};

export type ProviderScope = "global" | "user";

export type ProviderAccount = {
  id: string;
  provider: ProviderId;
  scope: ProviderScope;
  owner_user_id: string | null;
  display_name: string;
  base_url: string | null;
  api_version: string | null;
  region: string | null;
  status: string;
  is_default: boolean;
  created_at?: string;
  updated_at?: string;
};

export type ProviderModelBinding = {
  id: string;
  provider_account_id: string;
  model: string | null;
  display_name: string | null;
  enabled?: boolean;
  provider_model_ref?: Record<string, unknown> | null;
  capability_overrides?: Record<string, unknown> | null;
  usagePricing?: Record<string, unknown> | null;
};

export type ProvidersResponse = {
  accounts: ProviderAccount[];
  modelBindings: ProviderModelBinding[];
  byokEnabled: boolean;
};

export type Conversation = {
  id: string;
  project_id?: string | null;
  title: string;
  mode?: "chat" | "agent_test" | string;
  temporary?: boolean;
  archived_at?: string | null;
  created_at?: string;
  updated_at: string;
};

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "developer" | "tool" | string;
  content: unknown;
  metadata?: unknown;
  text: string;
  created_at: string;
};

export type Project = {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  default_model_preset_id?: string | null;
  created_at?: string;
  updated_at: string;
};

export type Prompt = {
  id: string;
  name: string;
  description: string | null;
  body: string;
  variables: string[];
  latest_version_id?: string | null;
  latest_version_number: number | null;
  created_at?: string;
  updated_at?: string;
};

export type KnowledgeBase = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  document_count?: number;
  created_at?: string;
  updated_at?: string;
};

export type KnowledgeDocument = {
  id: string;
  knowledge_base_id?: string;
  attachment_id?: string | null;
  title: string;
  mime_type: string | null;
  ingest_status: string;
  source_metadata?: { error?: string } | Record<string, unknown> | null;
  file_name?: string | null;
  size_bytes?: string | number | null;
  bucket?: string | null;
  object_key?: string | null;
  created_at: string;
  updated_at?: string;
};

export type KnowledgeSearchResult = {
  documentId: string;
  chunkId: string;
  chunkIndex: number;
  title: string;
  mimeType?: string | null;
  score: number;
  lexicalScore?: number;
  semanticScore?: number;
  coverageScore?: number;
  embeddingStatus?: string;
  snippet: string;
  citation: string;
};

export type AgentSpec = {
  name?: string;
  description?: string;
  instructions?: string;
  provider?: ProviderId | string;
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

export type Agent = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  current_draft_id?: string | null;
  published_version_id: string | null;
  created_at?: string;
  updated_at: string;
};

export type AgentDraft = {
  agent_id: string;
  draft_id: string;
  name: string;
  description: string | null;
  status: string;
  published_version_id?: string | null;
  base_version_id?: string | null;
  spec: AgentSpec;
  editor_state?: Record<string, unknown>;
  revision: number;
  updated_at?: string;
};

export type AgentRunEvent = {
  id: string;
  sequence_no: number;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type AgentRunStep = {
  id: string;
  sequence_no: number;
  step_type: string;
  status: string;
  name: string | null;
  input?: Record<string, unknown>;
  output: Record<string, unknown>;
};

export type AdminUser = {
  id: string;
  email: string;
  display_name: string | null;
  role: "admin" | "user" | string;
  status: string;
  byok_enabled: boolean;
  is_break_glass: boolean;
  created_at: string;
  last_login_at: string | null;
};

export type EmailDelivery = {
  provider: string;
  status: string;
  message?: string;
};

export type UsageSummaryRow = {
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

export type UsageRecentRow = {
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

export type UsageResponse = {
  summary: UsageSummaryRow[];
  recent: UsageRecentRow[];
};

export async function parseApiResponse<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => null)) as (T & ApiError) | null;
  if (!response.ok) {
    const error = data?.error;
    const message = typeof error === "string" ? error : error?.message;
    throw new Error(message ?? `Request failed with ${response.status}`);
  }
  return data as T;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  return parseApiResponse<T>(await authFetch(path, init));
}

function jsonInit(method: string, body?: JsonBody): RequestInit {
  return {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  };
}

function encodePath(value: string) {
  return encodeURIComponent(value);
}

export const apiClient = {
  auth: {
    me: (init?: RequestInit) => apiFetch<{ user: AuthUser }>("/api/auth/me", init)
  },
  providers: {
    list: (init?: RequestInit) => apiFetch<ProvidersResponse>("/api/providers", init),
    create: (body: { provider: ProviderId; scope?: ProviderScope; displayName?: string; apiKey: string; baseUrl?: string; apiVersion?: string; region?: string; isDefault?: boolean }) =>
      apiFetch<{ providerAccountId: string }>("/api/providers", jsonInit("POST", body)),
    updateAccount: (accountId: string, body: { displayName?: string; baseUrl?: string | null; apiVersion?: string | null; region?: string | null; status?: "enabled" | "disabled" | string; isDefault?: boolean }) =>
      apiFetch<{ providerAccountId: string }>(`/api/providers/accounts/${encodePath(accountId)}`, jsonInit("PATCH", body)),
    rotateKey: (accountId: string, apiKey: string) =>
      apiFetch<{ providerAccountId: string }>(`/api/providers/accounts/${encodePath(accountId)}/key`, jsonInit("PATCH", { apiKey })),
    deleteAccount: (accountId: string) =>
      apiFetch<{ providerAccountId: string }>(`/api/providers/accounts/${encodePath(accountId)}`, { method: "DELETE" }),
    test: (providerId: ProviderId | string, providerAccountId: string, adminOnly?: boolean) =>
      apiFetch<{ ok: boolean; message?: string }>(`/api/providers/${encodePath(providerId)}/test`, jsonInit("POST", { providerAccountId, adminOnly }))
  },
  conversations: {
    list: (init?: RequestInit) => apiFetch<{ conversations: Conversation[] }>("/api/conversations", init),
    create: (body: { title?: string; mode?: "chat" | "agent_test"; temporary?: boolean }) =>
      apiFetch<{ conversation: Conversation }>("/api/conversations", jsonInit("POST", body)),
    update: (conversationId: string, body: { title?: string; archived?: boolean }) =>
      apiFetch<{ conversation: Conversation }>(`/api/conversations/${encodePath(conversationId)}`, jsonInit("PATCH", body)),
    delete: (conversationId: string) =>
      apiFetch<{ deleted: true }>(`/api/conversations/${encodePath(conversationId)}`, { method: "DELETE" }),
    messages: (conversationId: string, init?: RequestInit) =>
      apiFetch<{ messages: ConversationMessage[] }>(`/api/conversations/${encodePath(conversationId)}/messages`, init)
  },
  projects: {
    list: (init?: RequestInit) => apiFetch<{ projects: Project[] }>("/api/projects", init),
    create: (body: { name: FormDataEntryValue | string | null; description?: FormDataEntryValue | string | null; instructions?: FormDataEntryValue | string | null }) =>
      apiFetch<{ project: Project }>("/api/projects", jsonInit("POST", body)),
    update: (projectId: string, body: { name?: string; description?: string | null; instructions?: string | null }) =>
      apiFetch<{ project: Project }>(`/api/projects/${encodePath(projectId)}`, jsonInit("PATCH", body)),
    delete: (projectId: string) => apiFetch<{ deleted: true }>(`/api/projects/${encodePath(projectId)}`, { method: "DELETE" })
  },
  prompts: {
    list: (init?: RequestInit) => apiFetch<{ prompts: Prompt[] }>("/api/prompts", init),
    create: (body: { name: FormDataEntryValue | string | null; description?: FormDataEntryValue | string | null; body: FormDataEntryValue | string | null; variables?: FormDataEntryValue | string[] | string | null }) =>
      apiFetch<{ prompt: Prompt }>("/api/prompts", jsonInit("POST", body)),
    update: (promptId: string, body: { name?: string; description?: string | null; body?: string; variables?: string[] | string }) =>
      apiFetch<{ prompt: Prompt }>(`/api/prompts/${encodePath(promptId)}`, jsonInit("PATCH", body)),
    delete: (promptId: string) => apiFetch<{ deleted: true }>(`/api/prompts/${encodePath(promptId)}`, { method: "DELETE" })
  },
  knowledge: {
    list: (init?: RequestInit) => apiFetch<{ knowledgeBases: KnowledgeBase[] }>("/api/knowledge", init),
    create: (body: { name: string; description?: string }) => apiFetch<{ knowledgeBaseId: string }>("/api/knowledge", jsonInit("POST", body)),
    update: (knowledgeBaseId: string, body: { name?: string; description?: string | null; status?: "active" | "archived"; archived?: boolean }) =>
      apiFetch<{ knowledgeBase: KnowledgeBase }>(`/api/knowledge/${encodePath(knowledgeBaseId)}`, jsonInit("PATCH", body)),
    delete: (knowledgeBaseId: string) => apiFetch<{ deleted: true }>(`/api/knowledge/${encodePath(knowledgeBaseId)}`, { method: "DELETE" }),
    documents: (knowledgeBaseId: string, init?: RequestInit) =>
      apiFetch<{ documents: KnowledgeDocument[] }>(`/api/knowledge/${encodePath(knowledgeBaseId)}/documents`, init),
    updateDocument: (knowledgeBaseId: string, documentId: string, body: { title: string }) =>
      apiFetch<{ document: KnowledgeDocument }>(`/api/knowledge/${encodePath(knowledgeBaseId)}/documents/${encodePath(documentId)}`, jsonInit("PATCH", body)),
    deleteDocument: (knowledgeBaseId: string, documentId: string) =>
      apiFetch<{ deleted: true }>(`/api/knowledge/${encodePath(knowledgeBaseId)}/documents/${encodePath(documentId)}`, { method: "DELETE" }),
    reembed: (knowledgeBaseId: string, body: { limit?: number; includeCurrent?: boolean } = {}) =>
      apiFetch<{ knowledgeBaseId: string; scanned: number; updated: number; skippedCurrent: number; reasons: Record<string, number>; hasMore: boolean }>(`/api/knowledge/${encodePath(knowledgeBaseId)}/reembed`, jsonInit("POST", body)),
    search: (knowledgeBaseId: string, body: { query: string; limit?: number; offset?: number; candidateLimit?: number }) =>
      apiFetch<{ query: string; results: KnowledgeSearchResult[]; pagination: Record<string, unknown>; embeddings: Record<string, unknown> }>(`/api/knowledge/${encodePath(knowledgeBaseId)}/search`, jsonInit("POST", body)),
    uploadFile: (body: FormData) => apiFetch<Record<string, unknown>>("/api/files/upload", { method: "POST", body })
  },
  agents: {
    list: (init?: RequestInit) => apiFetch<{ agents: Agent[] }>("/api/agents", init),
    create: (body: { name: string; description?: string; instructions?: string }) => apiFetch<{ agentId: string; draftId: string }>("/api/agents", jsonInit("POST", body)),
    update: (agentId: string, body: { name?: string; description?: string | null; status?: "draft" | "active" | "archived"; archived?: boolean }) =>
      apiFetch<{ agent: Agent }>(`/api/agents/${encodePath(agentId)}`, jsonInit("PATCH", body)),
    delete: (agentId: string) => apiFetch<{ deleted: true }>(`/api/agents/${encodePath(agentId)}`, { method: "DELETE" }),
    draft: (agentId: string, init?: RequestInit) => apiFetch<{ draft: AgentDraft }>(`/api/agents/${encodePath(agentId)}/draft`, init),
    updateDraft: (agentId: string, body: { name?: string; description?: string | null; spec?: AgentSpec; editorState?: Record<string, unknown> }) =>
      apiFetch<{ draft: AgentDraft }>(`/api/agents/${encodePath(agentId)}/draft`, jsonInit("PATCH", body)),
    publish: (agentId: string, body: { changeSummary?: string } = {}) =>
      apiFetch<{ version: { id: string; version_number: number } }>(`/api/agents/${encodePath(agentId)}/publish`, jsonInit("POST", body)),
    run: (agentId: string, body: { input: string; conversationId?: string; stream?: boolean }) =>
      apiFetch<Record<string, unknown>>(`/api/agents/${encodePath(agentId)}/runs`, jsonInit("POST", body)),
    runDetails: (agentId: string, runId: string, init?: RequestInit) =>
      apiFetch<{ run: Record<string, unknown>; events: AgentRunEvent[]; steps: AgentRunStep[] }>(`/api/agents/${encodePath(agentId)}/runs/${encodePath(runId)}`, init)
  },
  admin: {
    users: {
      list: (init?: RequestInit) => apiFetch<{ users: AdminUser[] }>("/api/admin/users", init),
      create: (body: { email: string; displayName?: string; role?: "admin" | "user"; byokEnabled?: boolean; password?: string; forceReset?: boolean }) =>
        apiFetch<{ userId?: string; inviteId?: string; inviteUrl?: string; emailDelivery?: EmailDelivery }>("/api/admin/users", jsonInit("POST", body)),
      updateByok: (userId: string, byokEnabled: boolean) =>
        apiFetch<{ userId: string; byokEnabled: boolean }>(`/api/admin/users/${encodePath(userId)}/byok`, jsonInit("PATCH", { byokEnabled })),
      createPasswordReset: (userId: string) =>
        apiFetch<{ resetId: string; resetUrl: string; emailDelivery?: EmailDelivery; email: string }>(`/api/admin/users/${encodePath(userId)}/password-reset`, { method: "POST" })
    },
    usage: (init?: RequestInit) => apiFetch<UsageResponse>("/api/admin/usage", init)
  }
};
