import type { NormalizedChatRequest, ProviderId, StreamEvent } from "@packetchat/contracts";
import type { ProviderAccountRuntime, StreamChatOptions } from "@packetchat/providers";
import type { ExecuteRunResume } from "./resume";
import type { UsageRecordInput } from "./usage";

export type AgentSpec = {
  name?: string;
  instructions?: string;
  provider?: ProviderId;
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

export type KnowledgeResult = {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId: string;
  chunkId: string;
  chunkIndex: number;
  title: string;
  score: number;
  snippet: string;
  citation: string;
};

// The agent identity a conversation message is attributed to. The run row
// already carries the version id; this is only what the message metadata needs.
export type RunVersion = { agent_id: string; agent_name: string };

export type RunFailureStatus = "failed" | "cancelled" | "timed_out";

/**
 * Outcome of claiming a queued run for execution. `status` is the run's current
 * status when the claim was refused, and null when the run row is gone.
 */
export type RunClaim =
  | { claimed: true }
  | { claimed: false; status: string | null };

export type RunExecutionResult =
  | { status: "completed"; outputText: string }
  | { status: "waiting_input"; approvalId: string; outputText: string };

export type AgentRunStepInput = {
  runId: string;
  sequenceNo: number;
  stepType: "system" | "llm" | "tool_call" | "tool_result" | "retrieval" | "approval" | "message";
  status: "running" | "completed" | "failed" | "cancelled";
  name: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
};

export type ModelBinding = { id: string; model: string; display_name: string };

export type ChildAgentRow = { name: string; spec: AgentSpec };

/**
 * Everything executeRun needs from the outside world. The defaults (see
 * ./deps) talk to postgres, the provider adapters, DNS and the network; tests
 * inject fakes. Nothing here is request-bound: the caller authorises first and
 * hands the executor an owner id, so the same ports serve the web route and the
 * queue worker.
 */
export type AgentRunDeps = {
  markRunRunning: (runId: string) => Promise<void>;
  markRunWaitingInput: (runId: string) => Promise<void>;
  markRunCompleted: (runId: string) => Promise<void>;
  markRunFailed: (input: { runId: string; status: RunFailureStatus; errorCode: string; message: string }) => Promise<void>;
  addRunEvent: (runId: string, eventType: string, payload: Record<string, unknown>) => Promise<void>;
  addRunStep: (input: AgentRunStepInput) => Promise<string>;
  // stepId is nullable because a run can fail before the llm step exists; the
  // update then matches nothing, exactly as it did inline in the route.
  completeStep: (stepId: string | null, output: Record<string, unknown>) => Promise<void>;
  failStep: (stepId: string | null, message: string) => Promise<void>;
  searchKnowledgeContext: (input: { userId: string; runId: string; query: string; knowledgeBaseIds: string[]; limit: number }) => Promise<KnowledgeResult[]>;
  fileContextBlock: (input: { userId: string; knowledgeBaseIds: string[]; maxChars: number }) => Promise<string>;
  loadProviderAccount: (accountId: string) => Promise<ProviderAccountRuntime | null>;
  loadModelBinding: (input: { accountId: string; provider: ProviderId; model: string }) => Promise<ModelBinding | null>;
  loadChildAgent: (input: { agentId: string; ownerUserId: string }) => Promise<ChildAgentRow | null>;
  streamChat: (account: ProviderAccountRuntime, request: NormalizedChatRequest, options?: StreamChatOptions) => AsyncIterable<StreamEvent>;
  recordUsage: (input: UsageRecordInput) => Promise<void>;
  // Resolved addresses for a hostname, [] when the lookup fails. Split out so
  // the SSRF guard is testable without DNS.
  resolveHost: (hostname: string) => Promise<string[]>;
  fetch: (url: URL, init: RequestInit) => Promise<Response>;
};

export type ExecuteRunInput = {
  runId: string;
  // The run's owner for resource lookups. The old inline signature also took a
  // `userId`; nothing in the executor ever read it, so it is gone.
  resourceOwnerUserId: string;
  spec: AgentSpec;
  inputText: string;
  signal?: AbortSignal;
  // Present when resuming a run paused on an approved approval. The external
  // actions that the approval gated now run, and step numbering continues
  // instead of restarting at 1. Absent for a fresh run, which still creates the
  // approval and waits.
  resume?: ExecuteRunResume;
};
