"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { ProviderId } from "@packetchat/contracts";
import { getAccessToken } from "../../lib/auth-client";
import { apiClient, type Conversation, type ConversationMessage, type ProviderAccount, type ProviderModelBinding } from "../../lib/api-client";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/ui";
import { renderMarkdown } from "../../lib/markdown";

const BOOKMARKS_KEY = "packetchat.chat.bookmarks";
const PENDING_AGENT_STORAGE_KEY = "packetchat.chat.pendingAgent";
const PENDING_PROMPT_STORAGE_KEY = "packetchat.chat.pendingPrompt";
const LAST_CONVERSATION_STORAGE_KEY = "packetchat.lastConversationId";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
};

type StreamEvent =
  | { type: "conversation"; conversationId: string; runId: string }
  | { type: "message_start"; responseId: string }
  | { type: "text_delta"; text: string }
  | { type: "message_end"; finishReason: string }
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
    content: [{ type: "text", text: message.content }]
  }));
}

function textFromContent(content: unknown) {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part ? String(part.text) : ""))
    .filter(Boolean)
    .join("\n");
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

function formatTimestamp(iso?: string) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
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

export default function ChatPage() {
  const toast = useToast();
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [modelBindings, setModelBindings] = useState<ProviderModelBinding[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [provider, setProvider] = useState<ProviderId>("openai-compatible");
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [displayName, setDisplayName] = useState("there");
  const [bookmarks, setBookmarks] = useState<Set<string>>(() => new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [speechSupported, setSpeechSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [hour, setHour] = useState<number | null>(null);
  const [activeAgent, setActiveAgent] = useState<{ id: string; name: string } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const selectedAccount = useMemo(() => accounts.find((account) => account.id === accountId), [accountId, accounts]);
  const selectedModelBindings = useMemo(
    () => modelBindings.filter((binding) => binding.provider_account_id === accountId && binding.model),
    [accountId, modelBindings]
  );
  const providerMismatch = !!(selectedAccount && selectedAccount.provider !== provider);
  const composerDisabled = isStreaming || loadingAccounts || !input.trim() || (!activeAgent && (!accountId || !model.trim() || providerMismatch));
  const hasMessages = messages.length > 0;
  const headerTitle = useMemo(() => {
    const active = conversations.find((c) => c.id === conversationId);
    if (activeAgent) return `${activeAgent.name} · agent`;
    if (active?.title) return model ? `${active.title} · ${model}` : active.title;
    return model ? `New chat · ${model}` : "New chat";
  }, [activeAgent, conversations, conversationId, model]);

  async function loadConversations() {
    const payload = await apiClient.conversations.list();
    setConversations(payload.conversations ?? []);
  }

  const loadConversation = useCallback(async (nextConversationId: string) => {
    const [messagePayload, conversationPayload] = await Promise.all([
      apiClient.conversations.messages(nextConversationId),
      apiClient.conversations.list().catch(() => ({ conversations: [] as Conversation[] }))
    ]);
    const restoredMessages = (messagePayload.messages ?? [])
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map<ChatMessage>((message) => ({
        id: message.id,
        role: message.role === "user" ? "user" : "assistant",
        content: message.text || textFromContent(message.content),
        createdAt: message.created_at
      }));
    const agentMessage = [...(messagePayload.messages ?? [])].reverse().find((message) => {
      const metadata = metadataRecord(message.metadata);
      return typeof metadata?.agentId === "string";
    });
    const agentMetadata = metadataRecord(agentMessage?.metadata);
    setMessages(restoredMessages);
    setConversationId(nextConversationId);
    setConversations(conversationPayload.conversations ?? []);
    if (typeof agentMetadata?.agentId === "string") {
      setActiveAgent({ id: agentMetadata.agentId, name: typeof agentMetadata.agentName === "string" ? agentMetadata.agentName : "Agent" });
      setShowSettings(false);
    } else {
      setActiveAgent(null);
    }
    try {
      window.localStorage.setItem(LAST_CONVERSATION_STORAGE_KEY, nextConversationId);
    } catch {
      // ignore storage errors
    }
  }, []);

  useEffect(() => {
    setHour(new Date().getHours());
    setBookmarks(loadBookmarkSet());
    if (typeof window !== "undefined") {
      const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
      setSpeechSupported(typeof Ctor === "function");
    }
  }, []);

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

        const deepConversationId = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("conversation") : null;
        if (deepConversationId) {
          void loadConversation(deepConversationId).catch((error) => {
            setStatus(error instanceof Error ? error.message : "Conversation link could not be loaded.");
          });
        }

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
          setShowSettings(true);
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
  }, [messages.length, isStreaming]);

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.stop();
      } catch {
        // ignore
      }
    };
  }, []);

  function updateAssistantMessage(id: string, updater: (content: string) => string) {
    setMessages((current) => current.map((message) => (message.id === id ? { ...message, content: updater(message.content) } : message)));
  }

  function handleAccountChange(nextAccountId: string) {
    setAccountId(nextAccountId);
    const nextAccount = accounts.find((account) => account.id === nextAccountId);
    if (nextAccount) setProvider(nextAccount.provider);
    const binding = modelBindings.find((item) => item.provider_account_id === nextAccountId && item.model);
    setModel(binding?.model ?? "");
  }

  async function sendContent(content: string, baseMessages: ChatMessage[]) {
    const accessToken = token();
    if (!content || isStreaming) return;
    if (!accessToken) {
      setStatus("You're signed out. Please sign in.");
      return;
    }
    if (!activeAgent && !accountId) {
      setStatus("Select an account before sending a message.");
      setShowSettings(true);
      return;
    }
    if (!activeAgent && !model.trim()) {
      setStatus("Pick a model first.");
      setShowSettings(true);
      return;
    }
    if (!activeAgent && providerMismatch) {
      setStatus("This account can't use that model.");
      return;
    }

    const now = new Date().toISOString();
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content, createdAt: now };
    const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "", createdAt: now };
    const requestMessages = [...baseMessages, userMessage];
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setIsStreaming(true);

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      if (activeAgent) {
        const payload = await apiClient.agents.run(activeAgent.id, { inputText: content, conversationId: conversationId || undefined, conversation: true }) as {
          outputText?: string;
          error?: string;
          status?: string;
          conversationId?: string;
        };
        if (payload.error) throw new Error(payload.error);
        if (payload.conversationId) {
          setConversationId(payload.conversationId);
          replaceConversationUrl(payload.conversationId);
        }
        updateAssistantMessage(assistantMessage.id, () => payload.outputText ?? "");
        await loadConversations().catch(() => undefined);
        return;
      }

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          conversationId: conversationId || undefined,
          providerAccountId: accountId,
          provider,
          model: model.trim(),
          stream: true,
          messages: normalizedMessages(requestMessages)
        }),
        signal: abortController.signal
      });

      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message ?? payload?.error ?? `Chat request failed with ${response.status}`);
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
            const streamEvent = JSON.parse(line.slice(5).trim()) as StreamEvent;
            if (streamEvent.type === "conversation") {
              setConversationId(streamEvent.conversationId);
              replaceConversationUrl(streamEvent.conversationId);
            }
            if (streamEvent.type === "text_delta") {
              updateAssistantMessage(assistantMessage.id, (current) => current + streamEvent.text);
            }
            if (streamEvent.type === "message_end") {
              setStatus("");
            }
            if (streamEvent.type === "error") {
              throw new Error(streamEvent.error.message ?? streamEvent.error.code ?? "Provider stream failed");
            }
          }
        }
      }

      await loadConversations().catch(() => undefined);
    } catch (error) {
      if (abortController.signal.aborted) {
        setStatus("Response stopped.");
      } else {
        const message = publicChatError(error);
        updateAssistantMessage(assistantMessage.id, (current) => current || message);
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
    if (!content || isStreaming) return;
    setInput("");
    void sendContent(content, messages);
  }

  function regenerate() {
    if (isStreaming) return;
    let lastUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "user") {
        lastUserIndex = index;
        break;
      }
    }
    if (lastUserIndex === -1) return;
    const lastUser = messages[lastUserIndex];
    const truncated = messages.slice(0, lastUserIndex);
    setMessages(truncated);
    void sendContent(lastUser.content, truncated);
  }

  function stopStreaming() {
    abortRef.current?.abort();
  }

  function onTextareaKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
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

  const handleStartEdit = useCallback((message: ChatMessage) => {
    setEditingId(message.id);
    setEditingDraft(message.content);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    setEditingDraft("");
  }, []);

  const handleSaveEdit = useCallback(() => {
    if (!editingId) return;
    const next = editingDraft;
    setMessages((current) => current.map((message) => (message.id === editingId ? { ...message, content: next } : message)));
    setEditingId(null);
    setEditingDraft("");
    toast({ message: "Message updated locally", variant: "info" });
  }, [editingDraft, editingId, toast]);

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
    <form className={`composer ${hasMessages ? "composer--float" : ""}`} onSubmit={sendMessage}>
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
          <span>{selectedAccount ? selectedAccount.scope : "Select an account"}</span>
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
        <div className="stage">
          <div className="greet">
            <span className="logo" aria-hidden="true" />
            <h1 className="greet__title">
              {hour === null ? `Hello, ${displayName}` : `Good ${greeting(hour)}, ${displayName}`}
            </h1>
          </div>
          {composerNode}
          {settingsNode}
        </div>
        <div className="footer">
          <Link href="/">PacketChat</Link> · your chats stay on this server
        </div>
      </>
    );
  }

  const lastAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "assistant") return messages[index].id;
    }
    return null;
  }, [messages]);

  return (
    <>
      <div className="doc" ref={transcriptRef} role="log" aria-live="polite" aria-label={headerTitle}>
        <div className="doc__wrap">
          {settingsNode}
          {messages.map((message) => (
            <Turn
              key={message.id}
              message={message}
              assistantLabel={activeAgent?.name || model || "Assistant"}
              isStreaming={isStreaming}
              isBookmarked={bookmarks.has(message.id)}
              isEditing={editingId === message.id}
              canRegenerate={!isStreaming && message.role === "assistant" && message.id === lastAssistantId}
              editingDraft={editingDraft}
              onEditingDraftChange={setEditingDraft}
              onCopy={handleCopy}
              onStartEdit={handleStartEdit}
              onCancelEdit={handleCancelEdit}
              onSaveEdit={handleSaveEdit}
              onToggleBookmark={handleToggleBookmark}
              onRegenerate={regenerate}
            />
          ))}
          {status && !isStreaming ? (
            <p className={isErrorStatus(status) ? "error-state chat-status" : "notice chat-status"} role={isErrorStatus(status) ? "alert" : "status"}>
              {status}
            </p>
          ) : null}
        </div>
      </div>
      {composerNode}
    </>
  );
}

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
  onRegenerate
}: TurnProps) {
  const isUser = message.role === "user";
  const placeholder = isStreaming && !isUser && !message.content ? "…" : "";
  const timestamp = formatTimestamp(message.createdAt);
  const showTools = !isUser && !!message.content && !isStreaming;
  const showRegenerate = canRegenerate && !isEditing && !isUser;

  return (
    <article className="turn">
      <div className="turn__head">
        <div className={`av ${isUser ? "u" : "a"}`} aria-hidden="true">{isUser ? "You" : "AI"}</div>
        <b>{isUser ? "You" : assistantLabel}</b>
        {timestamp ? (
          <>
            <span>·</span>
            <span suppressHydrationWarning>{timestamp}</span>
          </>
        ) : null}
      </div>
      {isEditing ? (
        <div className="turn__body">
          <textarea
            className="turn__edit"
            value={editingDraft}
            onChange={(event) => onEditingDraftChange(event.target.value)}
            rows={Math.min(12, Math.max(3, editingDraft.split("\n").length))}
            aria-label="Edit message"
          />
          <div className="turn__edit-actions">
            <button type="button" className="ib" onClick={onSaveEdit} aria-label="Save edit">Save</button>
            <button type="button" className="ib" onClick={onCancelEdit} aria-label="Cancel edit">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="turn__body">{message.content ? renderMarkdown(message.content) : placeholder}</div>
      )}
      {!isEditing && (showTools || showRegenerate) ? (
        <div className="turn__tools" role="group" aria-label="Assistant message actions">
          <button className="ib" type="button" title="Copy" aria-label="Copy" onClick={() => onCopy(message.content)}>
            <Icon.copy />
          </button>
          <button className="ib" type="button" title="Edit" aria-label="Edit" onClick={() => onStartEdit(message)}>
            <Icon.edit />
          </button>
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
        </div>
      ) : null}
      <style jsx>{`
        .turn__edit {
          width: 100%;
          font: inherit;
          color: inherit;
          background: rgba(127, 127, 127, 0.08);
          border: 1px solid rgba(127, 127, 127, 0.25);
          border-radius: 8px;
          padding: 10px 12px;
          resize: vertical;
        }
        .turn__edit-actions {
          display: flex;
          gap: 8px;
          margin-top: 8px;
        }
      `}</style>
    </article>
  );
}
