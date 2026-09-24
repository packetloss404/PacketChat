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
};


export type ProviderAccount = {
  id: string;
  provider: ProviderId;
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
};

export type Conversation = {
  id: string;
  project_id?: string | null;
  title: string;
  mode?: "chat" | "agent_test" | string;
  temporary?: boolean;
  archived_at?: string | null;
  active_leaf_message_id?: string | null;
  created_at?: string;
  updated_at: string;
};

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "developer" | "tool" | string;
  content: unknown;
  metadata?: unknown;
  text: string;
  parentMessageId?: string | null;
  createdAt?: string;
  created_at: string;
};

export type ConversationMessagesResponse = {
  messages: ConversationMessage[];
  activeLeafMessageId: string | null;
};

export type ConversationExportFormat = "md" | "json" | "txt";

export type ConversationShare = {
  id: string;
  conversationId: string;
  token: string;
  activeLeafMessageId: string | null;
  createdAt: string;
  revokedAt: string | null;
  revoked: boolean;
  url: string;
};

export type ChatRequestBody = {
  conversationId?: string | null;
  providerAccountId: string;
  provider: ProviderId;
  model: string;
  stream?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  messages: Array<{
    role: "system" | "developer" | "user" | "assistant" | "tool";
    content: Array<{ type: "text"; text: string }>;
  }>;
  /** Parent for a new user message; defaults to the conversation's active leaf. */
  parentMessageId?: string | null;
  /** Rerun an existing user message as a new branch instead of inserting one. */
  editMessageId?: string;
  /** Regenerate the assistant sibling under the given message instead of inserting a user message. */
  regenerate?: boolean;
  /** Chat-scoped attachments whose extracted text is injected for this turn. */
  attachmentIds?: string[];
};

export type ChatAttachmentExtractionStatus = "ready" | "unsupported" | "empty" | "failed" | string;

export type ChatAttachmentUpload = {
  attachmentId: string;
  documentId: null;
  scope: "chat";
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  extraction: {
    status: ChatAttachmentExtractionStatus;
    detectedType?: string;
    chars?: number;
    truncated?: boolean;
    error?: string;
  };
};

export type ProjectDefaultModelPreset = {
  id: string;
  name: string;
  provider: string;
  model: string;
};

export type Project = {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  default_model_preset_id?: string | null;
  default_model_preset?: ProjectDefaultModelPreset | null;
  conversation_count?: number;
  last_conversation_at?: string | null;
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
  matchedTerms?: string[];
  source?: {
    name: string;
    fileName?: string | null;
    detectedType?: string | null;
    attachmentId?: string | null;
    sizeBytes?: string | number | null;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
  };
  freshness?: {
    updatedAt: string;
    chunkCreatedAt?: string | null;
    embeddingStatus?: string;
    embeddingVersion?: string | null;
    embeddingCreatedAt?: string | null;
    embeddingRefreshedAt?: string | null;
    ageDays: number | null;
    label: string;
  };
  explanation?: string;
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

export type Agent = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  current_draft_id?: string | null;
  published_version_id: string | null;
  created_at?: string;
  updated_at: string;
  access_role?: "viewer" | "runner" | "editor" | "owner" | string;
  is_owner?: boolean;
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
  parent_step_id?: string | null;
  sequence_no: number;
  step_type: string;
  status: string;
  name: string | null;
  input?: Record<string, unknown>;
  output: Record<string, unknown>;
  started_at?: string | null;
  ended_at?: string | null;
};

export type AgentRunUsage = {
  provider: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  search_queries: number;
  cost_usd: number | null;
  usage_count: number;
  unknown_cost_count: number;
  estimated_count: number;
};

export type AgentRun = {
  id: string;
  agent_id: string;
  agent_version_id: string;
  conversation_id?: string | null;
  trigger_type?: string;
  status: string;
  input: Record<string, unknown>;
  started_at?: string | null;
  ended_at?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  created_at: string;
  step_count?: number;
  event_count?: number;
  usage?: AgentRunUsage;
};

export type ApprovalQueueItem = {
  id: string;
  runId: string;
  agentId: string;
  agentName: string;
  requesterEmail: string | null;
  sequenceNo: number;
  status: string;
  state: "pending" | "approved" | "rejected" | "closed" | string;
  name: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  runStatus: string;
  runInput: Record<string, unknown>;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  canDecide?: boolean;
};

export type SafeActionActivity = {
  id: string;
  runId: string;
  agentId: string;
  agentName: string;
  requesterEmail: string | null;
  sequenceNo: number;
  stepType: string;
  status: string;
  name: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  runStatus: string;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
};

export type ApprovalsResponse = {
  approvals: ApprovalQueueItem[];
  recentActions: SafeActionActivity[];
  stats: {
    pending: number;
    approvals: number;
    recentActions: number;
  };
};

export type AgentRunRequest = ({
  input: string;
  inputText?: string;
} | {
  inputText: string;
  input?: string;
}) & {
  conversationId?: string;
  conversation?: boolean;
  stream?: boolean;
};

export type AdminUser = {
  id: string;
  email: string;
  display_name: string | null;
  role: "admin" | "user" | string;
  status: string;
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
  governance?: {
    totals: {
      requests: number;
      costUsd: number;
      unknownCostCount: number;
      estimatedCount: number;
      activeUsers: number;
      projectedMonthCostUsd: number;
    };
    byUser: Array<{ user_email: string; request_count: number; cost_usd: number; unknown_cost_count: number }>;
    byProvider: Array<{ provider: string; request_count: number; cost_usd: number; unknown_cost_count: number }>;
    recommendations: string[];
  };
};

export type AdminAuditEvent = {
  id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  outcome: "success" | "failure" | string;
  target_type: string | null;
  target_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type AdminOperationsResponse = {
  providerAccounts: Array<{ provider: string; status: string; count: number }>;
  modelBindings: Array<{ provider: string; enabled: boolean; count: number }>;
  knowledge: Array<{ ingest_status: string; count: number }>;
  agentRuns: Array<{ status: string; count: number }>;
  jobFailures: Array<{ id: string; queue_name: string; job_name: string; job_id: string | null; error_message: string; created_at: string }>;
  recentProviderAudits: AdminAuditEvent[];
};

export type AdminApproval = {
  step_id: string;
  run_id: string;
  agent_id: string;
  agent_name: string;
  user_email: string;
  sequence_no: number;
  name: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  started_at: string;
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
    list: (init?: RequestInit & { includeDisabledModelBindings?: boolean }) => {
      const { includeDisabledModelBindings, ...requestInit } = init ?? {};
      const path = includeDisabledModelBindings ? "/api/providers?includeDisabledModelBindings=true" : "/api/providers";
      return apiFetch<ProvidersResponse>(path, requestInit);
    },
    create: (body: { provider: ProviderId; displayName?: string; apiKey: string; baseUrl?: string; apiVersion?: string; region?: string; isDefault?: boolean }) =>
      apiFetch<{ providerAccountId: string }>("/api/providers", jsonInit("POST", body)),
    updateAccount: (accountId: string, body: { displayName?: string; baseUrl?: string | null; apiVersion?: string | null; region?: string | null; status?: "enabled" | "disabled" | string; isDefault?: boolean }) =>
      apiFetch<{ providerAccountId: string }>(`/api/providers/accounts/${encodePath(accountId)}`, jsonInit("PATCH", body)),
    rotateKey: (accountId: string, apiKey: string) =>
      apiFetch<{ providerAccountId: string }>(`/api/providers/accounts/${encodePath(accountId)}/key`, jsonInit("PATCH", { apiKey })),
    updateBinding: (accountId: string, bindingId: string, enabled: boolean) =>
      apiFetch<{ providerAccountId: string; bindingId: string; enabled: boolean }>(
        `/api/providers/accounts/${encodePath(accountId)}/bindings/${encodePath(bindingId)}`,
        jsonInit("PATCH", { enabled })
      ),
    deleteAccount: (accountId: string) =>
      apiFetch<{ providerAccountId: string }>(`/api/providers/accounts/${encodePath(accountId)}`, { method: "DELETE" }),
    test: (providerId: ProviderId | string, providerAccountId: string) =>
      apiFetch<{ ok: boolean; message?: string }>(`/api/providers/${encodePath(providerId)}/test`, jsonInit("POST", { providerAccountId }))
  },
  conversations: {
    list: (init?: RequestInit & { search?: string }) => {
      const { search, ...requestInit } = init ?? {};
      const query = search?.trim() ? `?search=${encodeURIComponent(search.trim())}` : "";
      return apiFetch<{ conversations: Conversation[] }>(`/api/conversations${query}`, requestInit);
    },
    create: (body: { title?: string; mode?: "chat" | "agent_test"; temporary?: boolean }) =>
      apiFetch<{ conversation: Conversation }>("/api/conversations", jsonInit("POST", body)),
    update: (conversationId: string, body: { title?: string; archived?: boolean; activeLeafMessageId?: string | null }) =>
      apiFetch<{ conversation: Conversation }>(`/api/conversations/${encodePath(conversationId)}`, jsonInit("PATCH", body)),
    setActiveLeaf: (conversationId: string, activeLeafMessageId: string | null) =>
      apiFetch<{ conversation: Conversation }>(
        `/api/conversations/${encodePath(conversationId)}`,
        jsonInit("PATCH", { activeLeafMessageId })
      ),
    delete: (conversationId: string) =>
      apiFetch<{ deleted: true }>(`/api/conversations/${encodePath(conversationId)}`, { method: "DELETE" }),
    messages: (conversationId: string, init?: RequestInit) =>
      apiFetch<ConversationMessagesResponse>(`/api/conversations/${encodePath(conversationId)}/messages`, init),
    export: (conversationId: string, format: ConversationExportFormat = "md", init?: RequestInit) =>
      authFetch(`/api/conversations/${encodePath(conversationId)}/export?format=${encodeURIComponent(format)}`, init),
    share: {
      list: (conversationId: string, init?: RequestInit) =>
        apiFetch<{ shares: ConversationShare[] }>(`/api/conversations/${encodePath(conversationId)}/share`, init),
      create: (conversationId: string) =>
        apiFetch<{ share: ConversationShare }>(`/api/conversations/${encodePath(conversationId)}/share`, { method: "POST" }),
      revoke: (conversationId: string, shareId: string) =>
        apiFetch<{ share: ConversationShare }>(
          `/api/conversations/${encodePath(conversationId)}/share/${encodePath(shareId)}`,
          { method: "DELETE" }
        )
    }
  },
  chat: {
    send: (body: ChatRequestBody, init?: RequestInit) =>
      authFetch("/api/chat", { ...jsonInit("POST", body), ...init }),
    uploadAttachment: (body: FormData) =>
      apiFetch<ChatAttachmentUpload>("/api/files/upload", { method: "POST", body }),
    createWithParent: (body: ChatRequestBody, parentMessageId: string | null, init?: RequestInit) =>
      authFetch("/api/chat", { ...jsonInit("POST", { ...body, parentMessageId }), ...init }),
    regenerate: (body: ChatRequestBody, parentMessageId: string, init?: RequestInit) =>
      authFetch("/api/chat", { ...jsonInit("POST", { ...body, parentMessageId, regenerate: true }), ...init })
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
    runs: (agentId: string, init?: RequestInit) =>
      apiFetch<{ runs: AgentRun[] }>(`/api/agents/${encodePath(agentId)}/runs`, init),
    run: (agentId: string, body: AgentRunRequest) =>
      apiFetch<Record<string, unknown>>(`/api/agents/${encodePath(agentId)}/runs`, jsonInit("POST", { ...body, inputText: body.inputText ?? body.input })),
    runDetails: (agentId: string, runId: string, init?: RequestInit) =>
      apiFetch<{ run: AgentRun; usage: AgentRunUsage; events: AgentRunEvent[]; steps: AgentRunStep[] }>(`/api/agents/${encodePath(agentId)}/runs/${encodePath(runId)}`, init)
  },
  approvals: {
    list: (init?: RequestInit) => apiFetch<ApprovalsResponse>("/api/approvals", init),
    decide: (approvalId: string, body: { decision: "approved" | "rejected"; note?: string }) =>
      apiFetch<{ approval: Record<string, unknown> }>(`/api/approvals/${encodePath(approvalId)}`, jsonInit("PATCH", body))
  },
  admin: {
    users: {
      list: (init?: RequestInit) => apiFetch<{ users: AdminUser[] }>("/api/admin/users", init),
      create: (body: { email: string; displayName?: string; role?: "admin" | "user"; password?: string; forceReset?: boolean }) =>
        apiFetch<{ userId?: string; inviteId?: string; inviteUrl?: string; emailDelivery?: EmailDelivery }>("/api/admin/users", jsonInit("POST", body)),
      createPasswordReset: (userId: string) =>
        apiFetch<{ resetId: string; resetUrl: string; emailDelivery?: EmailDelivery; email: string }>(`/api/admin/users/${encodePath(userId)}/password-reset`, { method: "POST" })
    },
    usage: (init?: RequestInit) => apiFetch<UsageResponse>("/api/admin/usage", init),
    audit: (init?: RequestInit) => apiFetch<{ events: AdminAuditEvent[] }>("/api/admin/audit", init),
    operations: (init?: RequestInit) => apiFetch<AdminOperationsResponse>("/api/admin/operations", init),
    approvals: (init?: RequestInit) => apiFetch<{ approvals: AdminApproval[] }>("/api/admin/approvals", init)
  }
};
