"use client";

import { FormEvent, type KeyboardEvent as ReactKeyboardEvent, Suspense, type CSSProperties, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { buildActivePath, type ChatTreeMessage, type ProviderId } from "@packetchat/contracts";
import { getAccessToken } from "../../lib/auth-client";
import { apiClient, type ChatAttachmentUpload, type ChatRequestBody, type Conversation, type ConversationMessage, type ProviderAccount, type ProviderModelBinding } from "../../lib/api-client";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/ui";
import { renderMarkdown } from "../../lib/markdown";
import {
  artifactKindLabel,
  buildArtifactMessageView,
  buildSandboxedDocument,
  type ArtifactViewModel
} from "../../lib/artifacts/view-model";
import { setChatHeader, useModelPickerRequest } from "../../lib/chat-header-store";

const BOOKMARKS_KEY = "packetchat.chat.bookmarks";
const PENDING_AGENT_STORAGE_KEY = "packetchat.chat.pendingAgent";
const PENDING_PROMPT_STORAGE_KEY = "packetchat.chat.pendingPrompt";
const LAST_CONVERSATION_STORAGE_KEY = "packetchat.lastConversationId";
const DRAFT_STORAGE_KEY = "packetchat.chat.composerDraft";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  parentMessageId: string | null;
  createdAt?: string;
};

type MessageUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

type TurnRequest =
  | { kind: "new"; content: string; parentMessageId: string | null; baseMessages: ChatMessage[]; attachmentIds?: string[] }
  | { kind: "edit"; content: string; editMessageId: string; parentMessageId: string | null; baseMessages: ChatMessage[] }
  | { kind: "regenerate"; assistantMessageId: string; baseMessages: ChatMessage[] };

type StreamEvent =
  | { type: "conversation"; conversationId: string; runId: string; userMessageId: string; assistantMessageId: string; parentMessageId: string | null }
  | { type: "message_start"; responseId: string; messageId?: string }
  | { type: "text_delta"; text: string }
  | { type: "message_end"; finishReason: string; usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; searchQueries?: number }; messageId?: string }
  | { type: "conversation_updated"; conversationId: string; activeLeafMessageId: string | null; assistantMessageId: string | null }
  | { type: "error"; error: { message?: string; code?: string } };

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

function token() {
  return getAccessToken() ?? "";
}

function normalizedMessages(messages: ChatMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: [{ type: "text" as const, text: message.content }]
  }));
}

function textFromContent(content: unknown) {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part ? String(part.text) : ""))
    .filter(Boolean)
    .join("\n");
}

function toChatMessages(rows: ConversationMessage[]): ChatMessage[] {
  return rows
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      id: message.id,
      role: message.role === "user" ? "user" : "assistant",
      content: message.text || textFromContent(message.content),
      parentMessageId: message.parentMessageId ?? null,
      createdAt: message.createdAt ?? message.created_at
    }));
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readPendingPrompt(): { id?: string; name?: string; body?: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(PENDING_PROMPT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as { id?: string; name?: string; body?: string } : null;
  } catch {
    return null;
  }
}

function isErrorStatus(status: string) {
  const value = status.toLowerCase();
  return value.includes("error") || value.includes("failed") || value.includes("required") || value.includes("not found") || value.includes("no access") || value.includes("unauthenticated");
}

function publicChatError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/provider account|provider mismatch|model.*required|unauthenticated|no access/i.test(message)) return message;
  return "Chat failed. Check your model selection and try again.";
}

function greeting(hour: number) {
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function extractionStatusLabel(status: string): string {
  switch (status) {
    case "ready":
      return "extraction ready";
    case "unsupported":
      return "text extraction unsupported";
    case "empty":
      return "no text extracted";
    case "failed":
      return "text extraction failed";
    default:
      return status ? `extraction status ${status}` : "extraction status unknown";
  }
}

function formatTimestamp(iso?: string) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function createdValue(message: ChatMessage): number {
  const value = message.createdAt ? Date.parse(message.createdAt) : NaN;
  return Number.isNaN(value) ? 0 : value;
}

/**
 * Agent-run conversations persist every message with a null parent, so a strict
 * parent walk would render a single node. When no message has a parent we treat
 * the conversation as a flat chronological thread instead.
 */
function isFlatThread(messages: ChatMessage[]): boolean {
  return messages.length > 0 && messages.every((message) => !message.parentMessageId);
}

/**
 * A legacy flat message is a null-parent message that nothing links to. Those
 * are the preserved chronological prefix of a mixed thread, as opposed to a
 * genuine branching root (which has children).
 */
function flatPrefixIds(messages: ChatMessage[]): Set<string> {
  const hasChild = new Set(
    messages.filter((message) => message.parentMessageId).map((message) => message.parentMessageId as string)
  );
  return new Set(
    messages.filter((message) => !message.parentMessageId && !hasChild.has(message.id)).map((message) => message.id)
  );
}

/**
 * Temp optimistic ids are prefixed `local-` and are never valid on the server;
 * sending one as a parent/edit id makes the API reject the next turn.
 */
function serverMessageId(id: string | null | undefined): string | null {
  return id && !id.startsWith("local-") ? id : null;
}

function siblingsOf(messages: ChatMessage[], messageId: string): ChatMessage[] {
  const target = messages.find((message) => message.id === messageId);
  if (!target) return [];
  return messages
    .filter((message) => message.parentMessageId === target.parentMessageId)
    .sort((a, b) => createdValue(a) - createdValue(b) || a.id.localeCompare(b.id));
}

function adjacentSibling(messages: ChatMessage[], messageId: string, direction: 1 | -1): ChatMessage | null {
  const group = siblingsOf(messages, messageId);
  const index = group.findIndex((message) => message.id === messageId);
  if (index === -1) return null;
  return group[index + direction] ?? null;
}

/** Follows the newest child chain from `startId` to the branch's active leaf. */
function deepestLeaf(messages: ChatMessage[], startId: string): string {
  const children = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    if (!message.parentMessageId) continue;
    const list = children.get(message.parentMessageId) ?? [];
    list.push(message);
    children.set(message.parentMessageId, list);
  }
  let currentId = startId;
  const seen = new Set<string>([startId]);
  for (let guard = 0; guard <= messages.length; guard += 1) {
    const kids = children.get(currentId);
    if (!kids || kids.length === 0) break;
    const next = kids.reduce((latest, message) => (createdValue(message) >= createdValue(latest) ? message : latest));
    if (seen.has(next.id)) break;
    seen.add(next.id);
    currentId = next.id;
  }
  return currentId;
}

function announcement(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "Assistant finished responding.";
  return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
}

function loadBookmarkSet(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(BOOKMARKS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((item): item is string => typeof item === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function persistBookmarkSet(set: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // ignore quota/serialization errors
  }
}

function replaceConversationUrl(conversationId: string) {
  if (typeof window === "undefined") return;
  const nextUrl = `/chat?conversation=${encodeURIComponent(conversationId)}`;
  if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
    window.history.replaceState(null, "", nextUrl);
  }
}

function readName(prefix: string, key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(`${prefix}${key}`);
  } catch {
    return null;
  }
}

// Dead localStorage keys written by Settings → General, now read here.
function readGeneralPrefs() {
  const bool = (key: string, fallback: boolean) => {
    const raw = readName("packetchat.settings.general.", key);
    if (raw === "1" || raw === "true") return true;
    if (raw === "0" || raw === "false") return false;
    return fallback;
  };
  const num = (key: string, fallback: number) => {
    const raw = readName("packetchat.settings.general.", key);
    if (raw === null || raw === "") return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    sendOnEnter: bool("sendOnEnter", true),
    autosaveDrafts: bool("autosaveDrafts", true),
    showTokenCounts: bool("showTokenCounts", false),
    composerFontSize: num("composerFontSize", 14)
  };
}

const UserGlyph = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </svg>
);

const AssistantGlyph = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l1.8 4.9L18.7 9.7l-4.9 1.8L12 16.4l-1.8-4.9L5.3 9.7l4.9-1.8z" />
    <path d="M18.5 14.5l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z" />
  </svg>
);

const BranchPrevGlyph = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

const BranchNextGlyph = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

function ChatPage() {
  const toast = useToast();
  const searchParams = useSearchParams();
  const conversationParam = searchParams.get("conversation");
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [modelBindings, setModelBindings] = useState<ProviderModelBinding[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [provider, setProvider] = useState<ProviderId>("openai-compatible");
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [usageByMessage, setUsageByMessage] = useState<Record<string, MessageUsage>>({});
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [displayName, setDisplayName] = useState("there");
  const [bookmarks, setBookmarks] = useState<Set<string>>(() => new Set());
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [userEditDraft, setUserEditDraft] = useState("");
  const [speechSupported, setSpeechSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [hour, setHour] = useState<number | null>(null);
  const [activeAgent, setActiveAgent] = useState<{ id: string; name: string } | null>(null);
  const [sendOnEnter, setSendOnEnter] = useState(true);
  const [autosaveDrafts, setAutosaveDrafts] = useState(true);
  const [showTokenCounts, setShowTokenCounts] = useState(false);
  const [composerFontSize, setComposerFontSize] = useState(14);
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachmentUpload[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const selectedAccount = useMemo(() => accounts.find((account) => account.id === accountId), [accountId, accounts]);
  const selectedModelBindings = useMemo(
    () => modelBindings.filter((binding) => binding.provider_account_id === accountId && binding.model),
    [accountId, modelBindings]
  );
  const providerMismatch = !!(selectedAccount && selectedAccount.provider !== provider);
  const activeConversation = useMemo(() => conversations.find((candidate) => candidate.id === conversationId) ?? null, [conversations, conversationId]);
  const selectedModelBinding = useMemo(() => selectedModelBindings.find((binding) => binding.model === model) ?? null, [selectedModelBindings, model]);
  const isFlat = useMemo(() => isFlatThread(messages), [messages]);
  const flatPrefix = useMemo(() => flatPrefixIds(messages), [messages]);
  // The shared `buildActivePath` owns both the flat and mixed-thread fallbacks.
  // Adapt the optional `createdAt` to the contracts' required field, then map
  // the returned tree messages back to the richer `ChatMessage` shape.
  const activePath = useMemo(() => {
    if (messages.length === 0) return [] as ChatMessage[];
    const byId = new Map(messages.map((message) => [message.id, message]));
    const tree: ChatTreeMessage[] = messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.content,
      parentMessageId: message.parentMessageId,
      createdAt: message.createdAt ?? ""
    }));
    return buildActivePath(tree, activeLeafId)
      .map((message) => byId.get(message.id))
      .filter((message): message is ChatMessage => Boolean(message));
  }, [messages, activeLeafId]);
  const lastAssistantId = useMemo(() => {
    for (let index = activePath.length - 1; index >= 0; index -= 1) {
      if (activePath[index].role === "assistant") return activePath[index].id;
    }
    return null;
  }, [activePath]);

  const hasSendableContent = activeAgent
    ? input.trim().length > 0
    : input.trim().length > 0 || attachments.length > 0;
  const composerDisabled = isStreaming || isUploading || loadingAccounts || !hasSendableContent || (!activeAgent && (!accountId || !model.trim() || providerMismatch));
  const hasMessages = activePath.length > 0;
  const modelLabel = activeAgent ? "" : (selectedModelBinding?.display_name || model || "");
  const headerTitle = activeAgent ? activeAgent.name : (activeConversation?.title ?? null);

  async function loadConversations() {
    const payload = await apiClient.conversations.list();
    setConversations(payload.conversations ?? []);
  }

  const loadTree = useCallback(async (nextConversationId: string) => {
    const payload = await apiClient.conversations.messages(nextConversationId);
    setMessages(toChatMessages(payload.messages ?? []));
    setActiveLeafId(payload.activeLeafMessageId ?? null);
  }, []);

  const loadConversation = useCallback(async (nextConversationId: string) => {
    const [messagePayload, conversationPayload] = await Promise.all([
      apiClient.conversations.messages(nextConversationId),
      apiClient.conversations.list().catch(() => ({ conversations: [] as Conversation[] }))
    ]);
    const restoredMessages = toChatMessages(messagePayload.messages ?? []);
    const agentMessage = [...(messagePayload.messages ?? [])].reverse().find((message) => {
      const metadata = metadataRecord(message.metadata);
      return typeof metadata?.agentId === "string";
    });
    const agentMetadata = metadataRecord(agentMessage?.metadata);
    setMessages(restoredMessages);
    setActiveLeafId(messagePayload.activeLeafMessageId ?? null);
    setConversationId(nextConversationId);
    setConversations(conversationPayload.conversations ?? []);
    if (typeof agentMetadata?.agentId === "string") {
      setActiveAgent({ id: agentMetadata.agentId, name: typeof agentMetadata.agentName === "string" ? agentMetadata.agentName : "Agent" });
      setShowSettings(false);
      // Attachments are not supported in agent chat, so drop any that were
      // staged while a model conversation was active.
      setAttachments([]);
    } else {
      setActiveAgent(null);
    }
    try {
      window.localStorage.setItem(LAST_CONVERSATION_STORAGE_KEY, nextConversationId);
    } catch {
      // ignore storage errors
    }
  }, []);

  // Reload whenever the `?conversation=` query changes, including client-side
  // navigation between two conversations (which does not remount this page).
  useEffect(() => {
    if (!conversationParam || conversationParam === conversationId) return;
    if (!token()) return;
    void loadConversation(conversationParam).catch((error) => {
      setStatus(error instanceof Error ? error.message : "Conversation link could not be loaded.");
    });
  }, [conversationParam, conversationId, loadConversation]);

  useEffect(() => {
    setHour(new Date().getHours());
    setBookmarks(loadBookmarkSet());
    const prefs = readGeneralPrefs();
    setSendOnEnter(prefs.sendOnEnter);
    setAutosaveDrafts(prefs.autosaveDrafts);
    setShowTokenCounts(prefs.showTokenCounts);
    setComposerFontSize(prefs.composerFontSize);
    if (prefs.autosaveDrafts) {
      try {
        const draft = window.localStorage.getItem(DRAFT_STORAGE_KEY);
        if (draft) setInput(draft);
      } catch {
        // ignore storage errors
      }
    }
    if (typeof window !== "undefined") {
      const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
      setSpeechSupported(typeof Ctor === "function");
    }
  }, []);

  // Persist the composer draft only while autosave is enabled.
  useEffect(() => {
    if (!autosaveDrafts || typeof window === "undefined") return;
    try {
      if (input) window.localStorage.setItem(DRAFT_STORAGE_KEY, input);
      else window.localStorage.removeItem(DRAFT_STORAGE_KEY);
    } catch {
      // ignore storage errors
    }
  }, [input, autosaveDrafts]);

  // Drive the shared header with the real conversation title and model label.
  useEffect(() => {
    setChatHeader({ title: headerTitle, modelLabel: modelLabel || null });
  }, [headerTitle, modelLabel]);

  useEffect(() => {
    return () => setChatHeader({ title: null, modelLabel: null });
  }, []);

  // The header's model button increments this counter; open the picker when it does.
  const modelPickerRequest = useModelPickerRequest();
  const initialPickerRequestRef = useRef(modelPickerRequest);
  useEffect(() => {
    if (modelPickerRequest === initialPickerRequestRef.current) return;
    initialPickerRequestRef.current = modelPickerRequest;
    setShowSettings(true);
  }, [modelPickerRequest]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const promptId = params.get("prompt");
    const pendingPrompt = readPendingPrompt();
    window.sessionStorage.removeItem(PENDING_PROMPT_STORAGE_KEY);
    if (pendingPrompt?.body) {
      setInput(pendingPrompt.body);
      setStatus(`Loaded prompt${pendingPrompt.name ? `: ${pendingPrompt.name}` : ""}.`);
      return;
    }
    if (!promptId) return;
    apiClient.prompts
      .list()
      .then((payload) => {
        const prompt = payload.prompts.find((item) => item.id === promptId);
        if (!prompt) {
          setStatus("Prompt link not found or no longer accessible.");
          return;
        }
        setInput(prompt.body);
        setStatus(`Loaded prompt: ${prompt.name}.`);
      })
      .catch(() => setStatus("Prompt link could not be loaded."));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const fromQuery = new URLSearchParams(window.location.search).get("agent");
    const fromSession = window.sessionStorage.getItem(PENDING_AGENT_STORAGE_KEY);
    const agentId = fromQuery || fromSession;
    if (!agentId) return;
    window.sessionStorage.removeItem(PENDING_AGENT_STORAGE_KEY);
    apiClient.agents
      .draft(agentId)
      .then((payload) => {
        const name = payload.draft.spec.name || payload.draft.name || "Agent";
        setActiveAgent({ id: agentId, name });
        setAttachments([]);
        setShowSettings(false);
        setStatus(`Chatting with ${name}.`);
      })
      .catch(() => {
        apiClient.agents
          .list()
          .then((payload) => {
            const agent = payload.agents.find((item) => item.id === agentId);
            if (!agent) return;
            setActiveAgent({ id: agent.id, name: agent.name });
            setAttachments([]);
            setShowSettings(false);
            setStatus(`Chatting with ${agent.name}.`);
          })
          .catch(() => undefined);
      });
  }, []);

  useEffect(() => {
    if (!conversationId || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(LAST_CONVERSATION_STORAGE_KEY, conversationId);
    } catch {
      // ignore storage errors
    }
  }, [conversationId]);

  useEffect(() => {
    const accessToken = token();
    if (!accessToken) {
      setStatus("You're signed out. Please sign in.");
      setLoadingAccounts(false);
      return;
    }

    let cancelled = false;
    async function loadInitialData() {
      setLoadingAccounts(true);
      setStatus("");
      try {
        const [providerPayload, conversationPayload, meResponse] = await Promise.all([
          apiClient.providers.list(),
          apiClient.conversations.list(),
          fetch("/api/auth/me", { headers: { authorization: `Bearer ${accessToken}` } }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
        ]);
        if (cancelled) return;

        const nextAccounts = providerPayload.accounts ?? [];
        setAccounts(nextAccounts);
        setModelBindings(providerPayload.modelBindings ?? []);
        setConversations(conversationPayload.conversations ?? []);

        // The `?conversation=` deep link is loaded by the conversationParam
        // effect, which also covers navigation between conversations.

        const me = meResponse?.user ?? meResponse;
        if (me?.displayName || me?.email) {
          setDisplayName((me.displayName || me.email.split("@")[0]).toString());
        }

        const defaultAccount =
          nextAccounts.find((account) => account.is_default && account.status === "enabled") ??
          nextAccounts.find((account) => account.status === "enabled") ??
          nextAccounts[0];
        if (defaultAccount) {
          setAccountId(defaultAccount.id);
          setProvider(defaultAccount.provider);
          const defaultBinding = (providerPayload.modelBindings ?? []).find(
            (binding) => binding.provider_account_id === defaultAccount.id && binding.model
          );
          setModel(defaultBinding?.model ?? "");
        } else {
          setStatus("No models configured yet.");
        }
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setLoadingAccounts(false);
      }
    }

    loadInitialData();
    return () => {
      cancelled = true;
    };
  }, [loadConversation]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activePath.length, isStreaming]);

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.stop();
      } catch {
        // ignore
      }
      // Cancel any in-flight stream when the page unmounts.
      abortRef.current?.abort();
    };
  }, []);

  function handleAccountChange(nextAccountId: string) {
    setAccountId(nextAccountId);
    const nextAccount = accounts.find((account) => account.id === nextAccountId);
    if (nextAccount) setProvider(nextAccount.provider);
    const binding = modelBindings.find((item) => item.provider_account_id === nextAccountId && item.model);
    setModel(binding?.model ?? "");
  }

  async function runTurn(request: TurnRequest) {
    if (isStreaming) return;
    const accessToken = token();
    if (!activeAgent) {
      if (!accessToken) {
        setStatus("You're signed out. Please sign in.");
        return;
      }
      if (!accountId) {
        setStatus("Select an account before sending a message.");
        return;
      }
      if (!model.trim()) {
        setStatus("Pick a model first.");
        return;
      }
      if (providerMismatch) {
        setStatus("This account can't use that model.");
        return;
      }
    }

    const now = new Date().toISOString();
    const previousActiveLeafId = activeLeafId;
    const assistantTempId = `local-assistant-${crypto.randomUUID()}`;
    let userTempId: string | null = null;
    let requestMessages: ChatMessage[];

    // A `local-*` parent is a leftover optimistic temp and must never reach the
    // server; treat it as the root instead.
    const safeParentId = serverMessageId(request.kind === "new" || request.kind === "edit" ? request.parentMessageId : null);

    if (request.kind === "new" || request.kind === "edit") {
      userTempId = `local-user-${crypto.randomUUID()}`;
      requestMessages = [
        ...request.baseMessages,
        { id: userTempId, role: "user", content: request.content, parentMessageId: safeParentId, createdAt: now }
      ];
    } else {
      requestMessages = request.baseMessages;
    }

    const assistantParentId = userTempId
      ?? (request.kind === "regenerate"
        ? serverMessageId(messages.find((message) => message.id === request.assistantMessageId)?.parentMessageId)
        : null);

    const optimistic: ChatMessage[] = [];
    if (userTempId && (request.kind === "new" || request.kind === "edit")) {
      optimistic.push({ id: userTempId, role: "user", content: request.content, parentMessageId: safeParentId, createdAt: now });
    }
    optimistic.push({ id: assistantTempId, role: "assistant", content: "", parentMessageId: assistantParentId, createdAt: now });

    setMessages((current) => [...current, ...optimistic]);
    setActiveLeafId(assistantTempId);
    setIsStreaming(true);
    setLiveAnnouncement("");
    setStatus("");

    const abortController = new AbortController();
    abortRef.current = abortController;

    let assistantId = assistantTempId;
    let userId = userTempId;
    let streamConversationId = conversationId;
    let conversationEventReceived = false;
    const wasNewConversation = !conversationId;

    // Drops the optimistic user/assistant nodes and restores the pre-send leaf.
    const discardOptimistic = () => {
      const localIds = new Set([assistantTempId, userTempId].filter((id): id is string => Boolean(id)));
      setMessages((current) => current.filter((item) => !localIds.has(item.id)));
      setActiveLeafId(previousActiveLeafId);
    };

    const notifyConversationsChanged = () => {
      if (typeof window !== "undefined" && wasNewConversation) {
        window.dispatchEvent(new Event("packetchat:conversations-changed"));
      }
    };

    try {
      if (activeAgent) {
        const payload = await apiClient.agents.run(activeAgent.id, {
          inputText: request.kind === "regenerate" ? "" : request.content,
          conversationId: conversationId || undefined,
          conversation: true
        }) as { outputText?: string; error?: string; status?: string; conversationId?: string };
        if (payload.error) throw new Error(payload.error);
        if (payload.conversationId) {
          streamConversationId = payload.conversationId;
          setConversationId(payload.conversationId);
          replaceConversationUrl(payload.conversationId);
          notifyConversationsChanged();
        }
        const outputText = payload.outputText ?? "";
        setMessages((current) => current.map((message) => (message.id === assistantId ? { ...message, content: outputText } : message)));
        setLiveAnnouncement(announcement(outputText));
        if (streamConversationId) {
          await loadTree(streamConversationId).catch(() => undefined);
        } else {
          // No conversation was persisted, so the optimistic `local-*` nodes can
          // never be reconciled. Drop them instead of leaving a bogus parent id.
          discardOptimistic();
        }
        await loadConversations().catch(() => undefined);
        return;
      }

      if (!accessToken) throw new Error("You're signed out. Please sign in.");

      const body: ChatRequestBody = {
        conversationId: conversationId || undefined,
        providerAccountId: accountId,
        provider,
        model: model.trim(),
        stream: true,
        messages: normalizedMessages(requestMessages)
      };
      if (request.kind === "new") {
        body.parentMessageId = serverMessageId(request.parentMessageId);
        if (request.attachmentIds?.length) body.attachmentIds = request.attachmentIds;
      } else if (request.kind === "edit") {
        body.editMessageId = request.editMessageId;
      } else {
        body.regenerate = true;
        body.parentMessageId = serverMessageId(request.assistantMessageId);
      }

      const response = await apiClient.chat.send(body, { signal: abortController.signal });

      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } | string } | null;
        const message = typeof payload?.error === "string" ? payload.error : payload?.error?.message;
        throw new Error(message ?? `Chat request failed with ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";

        for (const chunk of chunks) {
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            let streamEvent: StreamEvent;
            try {
              streamEvent = JSON.parse(line.slice(5).trim()) as StreamEvent;
            } catch {
              continue;
            }

            if (streamEvent.type === "conversation") {
              conversationEventReceived = true;
              streamConversationId = streamEvent.conversationId;
              setConversationId(streamEvent.conversationId);
              replaceConversationUrl(streamEvent.conversationId);
              notifyConversationsChanged();
              const idMap = new Map<string, string>();
              if (userId) idMap.set(userId, streamEvent.userMessageId);
              idMap.set(assistantId, streamEvent.assistantMessageId);
              setMessages((current) => current.map((message) => ({
                ...message,
                id: idMap.get(message.id) ?? message.id,
                parentMessageId: message.parentMessageId ? (idMap.get(message.parentMessageId) ?? message.parentMessageId) : message.parentMessageId
              })));
              setActiveLeafId((current) => (current ? idMap.get(current) ?? current : current));
              userId = streamEvent.userMessageId;
              assistantId = streamEvent.assistantMessageId;
            }

            if (streamEvent.type === "text_delta") {
              setMessages((current) => current.map((message) => (message.id === assistantId ? { ...message, content: message.content + streamEvent.text } : message)));
            }

            if (streamEvent.type === "message_end") {
              if (streamEvent.usage) {
                const capturedUsage: MessageUsage = {
                  inputTokens: streamEvent.usage.inputTokens,
                  outputTokens: streamEvent.usage.outputTokens
                };
                const capturedId = assistantId;
                setUsageByMessage((current) => ({ ...current, [capturedId]: capturedUsage }));
              }
              setStatus("");
            }

            if (streamEvent.type === "conversation_updated") {
              if (streamEvent.activeLeafMessageId) setActiveLeafId(streamEvent.activeLeafMessageId);
            }

            if (streamEvent.type === "error") {
              throw new Error(streamEvent.error.message ?? streamEvent.error.code ?? "Provider stream failed");
            }
          }
        }
      }

      if (streamConversationId) await loadTree(streamConversationId).catch(() => undefined);
      await loadConversations().catch(() => undefined);
      setLiveAnnouncement("Assistant response complete.");
    } catch (error) {
      if (abortController.signal.aborted) {
        setStatus("Response stopped.");
        if (conversationEventReceived && streamConversationId) {
          // The server persisted the partial turn and its post-abort active leaf,
          // so reconcile with the authoritative tree instead of guessing a leaf.
          await loadTree(streamConversationId).catch(() => undefined);
        } else {
          // Nothing was persisted before the abort: remove the optimistic
          // `local-*` nodes and restore the previous leaf so the next send has a
          // real parentMessageId rather than a dangling temp id.
          discardOptimistic();
        }
      } else {
        const message = publicChatError(error);
        if (conversationEventReceived && streamConversationId) {
          // The server kept whatever it persisted; drop the optimistic nodes and
          // re-read the authoritative tree so the next turn has a valid parent.
          await loadTree(streamConversationId).catch(() => undefined);
        } else {
          discardOptimistic();
        }
        setStatus(message);
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }

  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = input.trim();
    const attachmentIds = attachments.map((attachment) => attachment.attachmentId);
    if (isStreaming || isUploading) return;
    // Agent runs require text: an attachment-only submit would start an empty run.
    if (!content && (activeAgent || attachmentIds.length === 0)) return;
    setInput("");
    setAttachments([]);
    const lastServerMessage = [...activePath].reverse().find((message) => !message.id.startsWith("local-"));
    const parentMessageId = serverMessageId(activeLeafId) ?? (lastServerMessage ? lastServerMessage.id : null);
    void runTurn({ kind: "new", content, parentMessageId, baseMessages: activePath, attachmentIds });
  }

  async function handleAttachFiles(fileList: FileList | null) {
    if (!fileList?.length) return;
    setIsUploading(true);
    const uploaded: ChatAttachmentUpload[] = [];
    for (const file of Array.from(fileList)) {
      const form = new FormData();
      form.append("file", file);
      form.append("scope", "chat");
      try {
        const result = await apiClient.chat.uploadAttachment(form);
        uploaded.push(result);
      } catch (error) {
        toast({ message: `Could not attach ${file.name}: ${error instanceof Error ? error.message : "upload failed"}`, variant: "error" });
      }
    }
    if (uploaded.length > 0) setAttachments((current) => [...current, ...uploaded]);
    setIsUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeAttachment(attachmentId: string) {
    setAttachments((current) => current.filter((attachment) => attachment.attachmentId !== attachmentId));
  }

  function submitUserEdit(message: ChatMessage) {
    if (isStreaming) return;
    // An optimistic temp has no server row to edit.
    if (message.id.startsWith("local-")) return;
    const content = userEditDraft.trim();
    if (!content) return;
    setEditingUserId(null);
    setUserEditDraft("");
    const index = activePath.findIndex((item) => item.id === message.id);
    const baseMessages = index >= 0 ? activePath.slice(0, index) : [];
    void runTurn({ kind: "edit", content, editMessageId: message.id, parentMessageId: serverMessageId(message.parentMessageId), baseMessages });
  }

  function submitRegenerate(message: ChatMessage) {
    if (isStreaming || activeAgent) return;
    const userIndex = message.parentMessageId ? activePath.findIndex((item) => item.id === message.parentMessageId) : -1;
    const baseMessages = userIndex >= 0 ? activePath.slice(0, userIndex + 1) : activePath;
    void runTurn({ kind: "regenerate", assistantMessageId: message.id, baseMessages });
  }

  function switchBranch(messageId: string, direction: 1 | -1) {
    if (!conversationId || isStreaming) return;
    const target = adjacentSibling(messages, messageId, direction);
    if (!target) return;
    const leaf = deepestLeaf(messages, target.id);
    setActiveLeafId(leaf);
    apiClient.conversations
      .update(conversationId, { activeLeafMessageId: leaf })
      .then(() => loadConversations())
      .catch((error) => setStatus(publicChatError(error)));
  }

  function stopStreaming() {
    abortRef.current?.abort();
  }

  function onTextareaKey(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    if (sendOnEnter) {
      if (event.shiftKey) return;
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function toggleListening() {
    if (!speechSupported) return;
    if (isListening) {
      try {
        recognitionRef.current?.stop();
      } catch {
        // ignore
      }
      return;
    }
    if (typeof window === "undefined") return;
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.lang = typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result && result[0]) {
          transcript += result[0].transcript;
        }
      }
      const trimmed = transcript.trim();
      if (trimmed) {
        setInput((current) => (current ? `${current.replace(/\s+$/, "")} ${trimmed}` : trimmed));
      }
    };
    recognition.onerror = (event) => {
      toast({ message: `Voice input error: ${event.error ?? "unknown"}`, variant: "error" });
    };
    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setIsListening(true);
    } catch (error) {
      setIsListening(false);
      recognitionRef.current = null;
      toast({ message: error instanceof Error ? error.message : "Could not start voice input", variant: "error" });
    }
  }

  const handleCopy = useCallback(async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      toast({ message: "Copied to clipboard", variant: "success" });
    } catch {
      toast({ message: "Could not copy to clipboard", variant: "error" });
    }
  }, [toast]);

  const handleStartUserEdit = useCallback((message: ChatMessage) => {
    setEditingUserId(message.id);
    setUserEditDraft(message.content);
  }, []);

  const handleCancelUserEdit = useCallback(() => {
    setEditingUserId(null);
    setUserEditDraft("");
  }, []);

  const handleToggleBookmark = useCallback((id: string) => {
    setBookmarks((current) => {
      const next = new Set(current);
      let added = false;
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        added = true;
      }
      persistBookmarkSet(next);
      toast({ message: added ? "Bookmarked" : "Bookmark removed", variant: "info" });
      return next;
    });
  }, [toast]);

  const composerNode = (
    <form
      className={`composer ${hasMessages ? "composer--float" : ""}`}
      style={{ "--composer-font-size": `${composerFontSize}px` } as CSSProperties}
      onSubmit={sendMessage}
    >
      {attachments.length > 0 ? (
        <div className="composer__attachments" role="group" aria-label="Attached files">
          {attachments.map((attachment) => (
            <span
              key={attachment.attachmentId}
              className="attach-chip"
              title={attachment.extraction.status === "ready" ? attachment.fileName : `${attachment.fileName} (context unavailable)`}
            >
              <Icon.attach />
              <span className="attach-chip__name">{attachment.fileName}</span>
              <span className="sr-only">{extractionStatusLabel(attachment.extraction.status)}</span>
              <button
                type="button"
                className="attach-chip__remove"
                aria-label={`Remove ${attachment.fileName}`}
                onClick={() => removeAttachment(attachment.attachmentId)}
              >
                <Icon.plus style={{ transform: "rotate(45deg)" }} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => void handleAttachFiles(event.target.files)}
      />
      <textarea
        rows={1}
        placeholder={activeAgent ? `Message ${activeAgent.name}` : model ? `Message ${model}` : "Ask anything"}
        aria-label="Message input"
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={onTextareaKey}
        disabled={isStreaming}
      />
      <div className="composer__row">
        {!activeAgent && selectedModelBindings.length > 0 ? (
          <span className="composer__model">
            <select
              aria-label="Model"
              title="Model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={isStreaming}
            >
              {!selectedModelBindings.some((binding) => binding.model === model) && model ? (
                <option value={model}>{model}</option>
              ) : null}
              {selectedModelBindings.map((binding) => (
                <option key={binding.id} value={binding.model ?? ""}>
                  {binding.display_name ?? binding.model}
                </option>
              ))}
            </select>
            <Icon.chev />
          </span>
        ) : null}
        <button
          className="ib"
          type="button"
          title="Model settings"
          aria-label="Model settings"
          aria-pressed={showSettings}
          onClick={() => setShowSettings((v) => !v)}
          disabled={Boolean(activeAgent)}
        >
          <Icon.mixer />
        </button>
        <button
          className="ib"
          type="button"
          title={
            activeAgent
              ? "Attachments are not available in agent chat"
              : isUploading
                ? "Uploading attachments..."
                : "Attach files"
          }
          aria-label="Attach files"
          onClick={() => fileInputRef.current?.click()}
          disabled={Boolean(activeAgent) || isStreaming || isUploading}
        >
          <Icon.attach />
        </button>
        <div className="spacer" />
        {isStreaming ? (
            <button className="ib composer__stop" type="button" title="Stop" aria-label="Stop" onClick={stopStreaming}>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        ) : (
          <button
            className="ib"
            type="button"
            title={speechSupported ? (isListening ? "Stop voice input" : "Voice input") : "Voice input requires a browser with Speech Recognition API"}
            aria-label="Voice input"
            aria-pressed={isListening}
            onClick={toggleListening}
            disabled={!speechSupported || isStreaming}
          >
            <Icon.mic />
          </button>
        )}
        {activeAgent ? (
          <button
            className="ib"
            type="button"
            title="Leave agent"
            aria-label="Leave agent"
            onClick={() => {
              setActiveAgent(null);
              setStatus("");
            }}
            disabled={isStreaming}
          >
            <Icon.plus style={{ transform: "rotate(45deg)" }} />
          </button>
        ) : null}
        <button className="send" type="submit" title="Send" aria-label="Send" disabled={composerDisabled}>
          <Icon.up />
        </button>
      </div>
    </form>
  );

  // Shown under the composer when the chat can't run yet. Clicking it opens
  // model settings, rather than the panel springing open on its own.
  const needsSetup = !activeAgent && !loadingAccounts && (accounts.length === 0 || !accountId || !model.trim());
  const setupNotice = needsSetup && !showSettings ? (
    <button
      className="composer-notice"
      type="button"
      onClick={() => setShowSettings(true)}
    >
      <span className="composer-notice__text">
        {accounts.length === 0
          ? "No models configured yet - set one up to start chatting."
          : "Choose an account and model to start chatting."}
      </span>
      <span className="composer-notice__cta">Model settings</span>
    </button>
  ) : null;

  const settingsNode = showSettings ? (
    <div className="chat-settings" role="region" aria-label="Chat settings">
      <div>
        <div className="eyebrow">Model</div>
        <h2>Model settings</h2>
        <p className="muted">Pick the account and model to use for this chat.</p>
      </div>

      {!loadingAccounts && accounts.length === 0 ? (
        <div className="warning" role="status">
          No models configured yet. Add one in <Link className="link-button" href="/providers">Models</Link> first.
        </div>
      ) : null}

      <div className="chat-settings__fields">
        <label>
          Account
          <select aria-label="Account" value={accountId} onChange={(event) => handleAccountChange(event.target.value)} disabled={loadingAccounts || isStreaming}>
            <option value="">{loadingAccounts ? "Loading models..." : "Select an account"}</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id} disabled={account.status !== "enabled"}>
                {account.display_name}
              </option>
            ))}
          </select>
        </label>
        <div className="route-card">
          <span className="route-card__label">Provider</span>
          <strong>{selectedAccount?.provider ?? provider}</strong>
          <span>{selectedAccount ? selectedAccount.display_name : "Select an account"}</span>
        </div>
        <label>
          {selectedAccount?.provider === "azure-openai" ? "Azure deployment" : "Model"}
          {selectedModelBindings.length ? (
            <select aria-label="Model" value={model} onChange={(event) => setModel(event.target.value)} disabled={isStreaming}>
              <option value="">Choose a model</option>
              {selectedModelBindings.map((binding) => (
                <option key={binding.id} value={binding.model ?? ""}>
                  {binding.display_name ?? binding.model}
                </option>
              ))}
            </select>
          ) : (
            <input
              aria-label="Model name"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="Model name"
              disabled={isStreaming}
            />
          )}
        </label>
      </div>

      {providerMismatch ? (
        <p className="warning chat-warning" role="alert">This account can't use that model.</p>
      ) : null}

      {status ? (
        <p className={isErrorStatus(status) ? "error-state chat-status" : "notice chat-status"} role={isErrorStatus(status) ? "alert" : "status"}>
          {status}
        </p>
      ) : null}
    </div>
  ) : null;

  if (!hasMessages) {
    return (
      <>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{liveAnnouncement}</p>
        <div className="stage">
          <div className="greet">
            <span className="logo" aria-hidden="true" />
            <h1 className="greet__title">
              {hour === null ? `Hello, ${displayName}` : `Good ${greeting(hour)}, ${displayName}`}
            </h1>
          </div>
          {composerNode}
          {setupNotice}
          {/* settingsNode renders its own copy of status, so only surface it
              here when the panel is closed - otherwise it appears twice. */}
          {!showSettings && status && !isStreaming ? (
            <p className={isErrorStatus(status) ? "error-state chat-status" : "notice chat-status"} role={isErrorStatus(status) ? "alert" : "status"}>
              {status}
            </p>
          ) : null}
          {settingsNode}
        </div>
        <div className="footer">
          <Link href="/">PacketChat</Link> · your chats stay on this server
        </div>
      </>
    );
  }

  return (
    <>
      <div className="doc" ref={transcriptRef}>
        <div className="doc__wrap">
          {settingsNode}
          {activePath.map((message) => {
            // Legacy flat messages (and their preserved prefix) never branch.
            const isFlatMessage = isFlat || flatPrefix.has(message.id);
            const siblings = isFlatMessage
              ? [message]
              : siblingsOf(messages, message.id).filter((sibling) => !flatPrefix.has(sibling.id));
            const branch = !isFlatMessage && siblings.length > 1
              ? {
                  index: siblings.findIndex((sibling) => sibling.id === message.id) + 1,
                  count: siblings.length,
                  canPrev: siblings.findIndex((sibling) => sibling.id === message.id) > 0,
                  canNext: siblings.findIndex((sibling) => sibling.id === message.id) < siblings.length - 1,
                  onPrev: () => switchBranch(message.id, -1),
                  onNext: () => switchBranch(message.id, 1)
                }
              : undefined;
            return (
              <Turn
                key={message.id}
                message={message}
                assistantLabel={activeAgent?.name || model || "Assistant"}
                isStreaming={isStreaming}
                isBookmarked={bookmarks.has(message.id)}
                isEditing={message.role === "user" && editingUserId === message.id}
                canRegenerate={!activeAgent && !isStreaming && message.role === "assistant" && message.id === lastAssistantId}
                editingDraft={userEditDraft}
                onEditingDraftChange={setUserEditDraft}
                onCopy={handleCopy}
                onStartEdit={handleStartUserEdit}
                onCancelEdit={handleCancelUserEdit}
                onSaveEdit={() => submitUserEdit(message)}
                onToggleBookmark={handleToggleBookmark}
                onRegenerate={() => submitRegenerate(message)}
                branch={branch}
                usage={usageByMessage[message.id]}
                showTokenCounts={showTokenCounts}
              />
            );
          })}
          {/* settingsNode renders its own status copy, so only surface it here
              when the panel is closed to avoid a duplicate live region. */}
          {!showSettings && status && !isStreaming ? (
            <p className={isErrorStatus(status) ? "error-state chat-status" : "notice chat-status"} role={isErrorStatus(status) ? "alert" : "status"}>
              {status}
            </p>
          ) : null}
        </div>
      </div>
      {/* One live-region announcement per completed turn, never per token. */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{liveAnnouncement}</p>
      {composerNode}
      {setupNotice}
    </>
  );
}

type BranchInfo = {
  index: number;
  count: number;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
};

type TurnProps = {
  message: ChatMessage;
  assistantLabel: string;
  isStreaming: boolean;
  isBookmarked: boolean;
  isEditing: boolean;
  canRegenerate: boolean;
  editingDraft: string;
  onEditingDraftChange: (value: string) => void;
  onCopy: (content: string) => void;
  onStartEdit: (message: ChatMessage) => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onToggleBookmark: (id: string) => void;
  onRegenerate: () => void;
  branch?: BranchInfo;
  usage?: MessageUsage;
  showTokenCounts: boolean;
};

function Turn({
  message,
  assistantLabel,
  isStreaming,
  isBookmarked,
  isEditing,
  canRegenerate,
  editingDraft,
  onEditingDraftChange,
  onCopy,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onToggleBookmark,
  onRegenerate,
  branch,
  usage,
  showTokenCounts
}: TurnProps) {
  const isUser = message.role === "user";
  const placeholder = isStreaming && !isUser && !message.content;
  const timestamp = formatTimestamp(message.createdAt);
  const showAssistantTools = !isUser && !!message.content && !isStreaming;
  const showUserTools = isUser && !!message.content && !isStreaming;
  const showRegenerate = canRegenerate;

  return (
    <article className={`turn ${isUser ? "turn--user" : "turn--assistant"}`}>
      <div className="turn__head">
        <span className={`av ${isUser ? "av--user" : "av--assistant"}`} aria-hidden="true">
          {isUser ? <UserGlyph /> : <AssistantGlyph />}
        </span>
        <b>{isUser ? "You" : assistantLabel}</b>
        {timestamp ? (
          <>
            <span className="turn__sep" aria-hidden="true">·</span>
            <time className="turn__time" dateTime={message.createdAt} suppressHydrationWarning>{timestamp}</time>
          </>
        ) : null}
        {showTokenCounts && usage ? (
          <span className="turn__usage">
            {usage.inputTokens ?? 0} in / {usage.outputTokens ?? 0} out
          </span>
        ) : null}
        {branch ? (
          <span className="turn__branch" role="group" aria-label={`Branches, showing ${branch.index} of ${branch.count}`}>
            <button
              className="ib turn__branch-btn"
              type="button"
              aria-label="Previous branch"
              disabled={!branch.canPrev}
              onClick={branch.onPrev}
            >
              <BranchPrevGlyph />
            </button>
            <span className="turn__branch-count" aria-hidden="true">{branch.index} of {branch.count}</span>
            <button
              className="ib turn__branch-btn"
              type="button"
              aria-label="Next branch"
              disabled={!branch.canNext}
              onClick={branch.onNext}
            >
              <BranchNextGlyph />
            </button>
          </span>
        ) : null}
      </div>
      {isEditing ? (
        <div className="turn__body turn__body--editing">
          <textarea
            className="turn__edit"
            value={editingDraft}
            onChange={(event) => onEditingDraftChange(event.target.value)}
            rows={Math.min(12, Math.max(3, editingDraft.split("\n").length))}
            aria-label="Edit message and rerun"
          />
          <div className="turn__edit-actions">
            <button type="button" className="button button--primary" onClick={onSaveEdit} disabled={!editingDraft.trim()}>
              Save &amp; rerun
            </button>
            <button type="button" className="button button--ghost" onClick={onCancelEdit}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="turn__body">
          {isUser ? (
            message.content ? renderMarkdown(message.content) : null
          ) : (
            <AssistantBody content={message.content} placeholder={placeholder} />
          )}
        </div>
      )}
      {!isEditing && (showAssistantTools || showUserTools) ? (
        <div className="turn__tools" role="group" aria-label={isUser ? "Your message actions" : "Assistant message actions"}>
          <button className="ib" type="button" title="Copy" aria-label="Copy message" onClick={() => onCopy(message.content)}>
            <Icon.copy />
          </button>
          {isUser ? (
            <button className="ib" type="button" title="Edit and rerun" aria-label="Edit and rerun" onClick={() => onStartEdit(message)}>
              <Icon.edit />
            </button>
          ) : (
            <>
              <button
                className="ib"
                type="button"
                title={isBookmarked ? "Remove bookmark" : "Bookmark"}
                aria-label={isBookmarked ? "Remove bookmark" : "Bookmark"}
                aria-pressed={isBookmarked}
                onClick={() => onToggleBookmark(message.id)}
              >
                {isBookmarked ? (
                  <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                  </svg>
                ) : (
                  <Icon.bookmark />
                )}
              </button>
              {showRegenerate ? (
                <button className="turn__tool--regenerate" type="button" title="Regenerate response" aria-label="Regenerate response" onClick={onRegenerate}>
                  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                    <polyline points="21 3 21 9 15 9" />
                  </svg>
                  <span>Regenerate</span>
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </article>
  );
}

/**
 * Splits an assistant message into prose and artifact view models. Only called
 * for assistant turns; user turns render through the plain markdown renderer.
 * The artifact fences are stripped from the prose by `buildArtifactMessageView`
 * so raw source is never shown twice.
 */
function AssistantBody({ content, placeholder }: { content: string; placeholder: boolean }) {
  const view = useMemo(() => buildArtifactMessageView(content), [content]);

  if (!content) {
    return placeholder ? <span className="turn__thinking">…</span> : null;
  }

  return (
    <>
      {view.prose ? renderMarkdown(view.prose) : null}
      {view.artifacts.length > 0 ? (
        <div className="artifacts">
          {view.artifacts.map((artifact, index) => (
            <ArtifactCard key={`${artifact.identifier}-${index}`} view={artifact} />
          ))}
        </div>
      ) : null}
    </>
  );
}

function ArtifactWarnings({ view }: { view: ArtifactViewModel }) {
  if (view.warnings.length === 0) return null;
  return (
    <ul className="artifact__warnings">
      {view.warnings.map((warning, index) => (
        <li key={index}>{warning}</li>
      ))}
    </ul>
  );
}

/**
 * Renders a single artifact according to its presentation. HTML/SVG always go
 * through a sandboxed `srcDoc` iframe; markdown goes through the existing safe
 * React markdown renderer; mermaid/react stay inert `<pre>` data.
 */
function ArtifactPreview({ view }: { view: ArtifactViewModel }) {
  if (view.presentation === "iframe") {
    return (
      <iframe
        className="artifact__frame"
        title={`${view.title} preview`}
        sandbox={view.iframeSandbox}
        srcDoc={buildSandboxedDocument(view)}
        referrerPolicy="no-referrer"
        loading="lazy"
      />
    );
  }
  if (view.presentation === "markdown") {
    return <div className="artifact__markdown">{renderMarkdown(view.content)}</div>;
  }
  if (view.presentation === "code") {
    return (
      <pre className="artifact__code">
        <code>{view.content}</code>
      </pre>
    );
  }
  return <p className="artifact__unsupported">This artifact type is not supported and was not rendered.</p>;
}

function ArtifactCard({ view }: { view: ArtifactViewModel }) {
  const [open, setOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const previewId = useId();
  const expandRef = useRef<HTMLButtonElement | null>(null);
  const presentable = view.presentation !== "unsupported";

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    // Return focus to the control that opened the panel.
    expandRef.current?.focus();
  }, []);

  return (
    <section
      className={`artifact ${open ? "artifact--open" : "artifact--collapsed"}`}
      aria-label={`${artifactKindLabel(view.kind)} artifact: ${view.title}`}
    >
      <div className="artifact__head">
        <span className="artifact__badge">{artifactKindLabel(view.kind)}</span>
        <span className="artifact__title" title={view.type}>{view.title}</span>
        <span className="artifact__head-spacer" />
        {presentable ? (
          <span className="artifact__actions">
            <button
              type="button"
              className="artifact__btn"
              aria-expanded={open}
              aria-controls={previewId}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? "Close" : "Open"}
            </button>
            <button
              ref={expandRef}
              type="button"
              className="artifact__btn artifact__btn--primary"
              aria-haspopup="dialog"
              onClick={() => setPanelOpen(true)}
            >
              Expand
            </button>
          </span>
        ) : (
          <span className="artifact__note">Not rendered</span>
        )}
      </div>
      <ArtifactWarnings view={view} />
      {open && presentable ? (
        <div className="artifact__preview" id={previewId}>
          <ArtifactPreview view={view} />
          {view.presentation === "code" ? (
            <p className="artifact__note">Inert data — never executed.</p>
          ) : null}
        </div>
      ) : null}
      {panelOpen && presentable ? <ArtifactPanel view={view} onClose={closePanel} /> : null}
    </section>
  );
}

/**
 * Larger artifact view. Mirrors the inline dialog pattern used elsewhere:
 * `role="dialog"` + `aria-modal`, backdrop click closes, Esc closes, focus is
 * moved into the dialog and trapped there, then restored on close.
 */
function ArtifactPanel({ view, onClose }: { view: ArtifactViewModel; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const node = dialogRef.current;
      if (!node) return;
      const focusable = node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !node.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !node.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="artifact-panel"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="artifact-panel__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${artifactKindLabel(view.kind)} artifact: ${view.title}`}
      >
        <header className="artifact-panel__head">
          <span className="artifact__badge">{artifactKindLabel(view.kind)}</span>
          <h2 className="artifact-panel__title">{view.title}</h2>
          <span className="artifact__head-spacer" />
          <button
            ref={closeRef}
            type="button"
            className="artifact__btn artifact__btn--icon"
            aria-label="Close artifact"
            title="Close"
            onClick={onClose}
          >
            <Icon.plus style={{ transform: "rotate(45deg)" }} />
          </button>
        </header>
        <ArtifactWarnings view={view} />
        <div className="artifact-panel__body">
          <ArtifactPreview view={view} />
        </div>
      </div>
    </div>
  );
}

// useSearchParams needs a Suspense boundary during prerender; the chat page
// uses it to react to `?conversation=` changes without remounting.
export default function ChatPageRoute() {
  return (
    <Suspense fallback={null}>
      <ChatPage />
    </Suspense>
  );
}
