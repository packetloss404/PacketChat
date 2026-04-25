"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { ProviderId } from "@packetchat/contracts";
import { getAccessToken } from "../../lib/auth-client";
import { apiClient, type Conversation, type ConversationMessage, type ProviderAccount, type ProviderModelBinding } from "../../lib/api-client";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/ui";

const APP_VERSION = "v0.8.2-rc1";
const BOOKMARKS_KEY = "packetchat.chat.bookmarks";

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

function isErrorStatus(status: string) {
  const value = status.toLowerCase();
  return value.includes("error") || value.includes("failed") || value.includes("required") || value.includes("not found") || value.includes("no access") || value.includes("unauthenticated");
}

function greeting(hour: number) {
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function renderBody(body: string) {
  const parts = body.split(/(`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    return <span key={index}>{part}</span>;
  });
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
  const [attachmentName, setAttachmentName] = useState<string | null>(null);
  const [bookmarks, setBookmarks] = useState<Set<string>>(() => new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [speechSupported, setSpeechSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [hour, setHour] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const selectedAccount = useMemo(() => accounts.find((account) => account.id === accountId), [accountId, accounts]);
  const selectedModelBindings = useMemo(
    () => modelBindings.filter((binding) => binding.provider_account_id === accountId && binding.model),
    [accountId, modelBindings]
  );
  const providerMismatch = !!(selectedAccount && selectedAccount.provider !== provider);
  const composerDisabled = isStreaming || loadingAccounts || !input.trim() || !accountId || !model.trim() || providerMismatch;
  const hasMessages = messages.length > 0;
  const headerTitle = useMemo(() => {
    const active = conversations.find((c) => c.id === conversationId);
    if (active?.title) return `${active.title} · ${model || "no model"}`;
    return model ? `New chat · ${model}` : "New chat";
  }, [conversations, conversationId, model]);

  async function loadConversations() {
    const payload = await apiClient.conversations.list();
    setConversations(payload.conversations ?? []);
  }

  useEffect(() => {
    setHour(new Date().getHours());
    setBookmarks(loadBookmarkSet());
    if (typeof window !== "undefined") {
      const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
      setSpeechSupported(typeof Ctor === "function");
    }
  }, []);

  useEffect(() => {
    const accessToken = token();
    if (!accessToken) {
      setStatus("No access token found. Sign in before chatting.");
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
          setStatus("No provider accounts are accessible for this user.");
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
  }, []);

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

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = input.trim();
    const accessToken = token();
    if (!content || isStreaming) return;
    if (!accessToken) {
      setStatus("No access token found. Sign in before chatting.");
      return;
    }
    if (!accountId) {
      setStatus("Choose a provider account before sending a message.");
      setShowSettings(true);
      return;
    }
    if (!model.trim()) {
      setStatus("Enter the provider model or Azure deployment name before sending a message.");
      setShowSettings(true);
      return;
    }
    if (providerMismatch) {
      setStatus("Selected provider id must match the selected provider account.");
      return;
    }

    const now = new Date().toISOString();
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content, createdAt: now };
    const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "", createdAt: now };
    const requestMessages = [...messages, userMessage];
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setInput("");
    setStatus("Streaming response...");
    setIsStreaming(true);

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
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
            }
            if (streamEvent.type === "text_delta") {
              updateAssistantMessage(assistantMessage.id, (current) => current + streamEvent.text);
            }
            if (streamEvent.type === "message_end") {
              setStatus(`Finished: ${streamEvent.finishReason}`);
            }
            if (streamEvent.type === "error") {
              throw new Error(streamEvent.error.message ?? streamEvent.error.code ?? "Provider stream failed");
            }
          }
        }
      }

      setStatus((current) => (current.startsWith("Finished:") ? current : "Response complete."));
      await loadConversations().catch(() => undefined);
    } catch (error) {
      if (abortController.signal.aborted) {
        setStatus("Response stopped.");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        updateAssistantMessage(assistantMessage.id, (current) => current || `Error: ${message}`);
        setStatus(message);
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
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

  function handleAttachClick() {
    fileInputRef.current?.click();
  }

  function handleAttachChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setAttachmentName(file.name);
    toast({ message: "File attachments are coming soon", variant: "info" });
    event.target.value = "";
  }

  function clearAttachment() {
    setAttachmentName(null);
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
        placeholder={`Message Claude · ${model || "select a model"}`}
        aria-label="Message"
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={onTextareaKey}
        disabled={isStreaming}
      />
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: "none" }}
        onChange={handleAttachChange}
        aria-hidden="true"
        tabIndex={-1}
      />
      <div className="composer__row">
        <button className="ib" type="button" title="Attach" aria-label="Attach" onClick={handleAttachClick} disabled={isStreaming}>
          <Icon.attach />
        </button>
        <button
          className="ib"
          type="button"
          title="Settings"
          aria-label="Settings"
          aria-pressed={showSettings}
          onClick={() => setShowSettings((v) => !v)}
        >
          <Icon.mixer />
        </button>
        <div className="spacer" />
        {isStreaming ? (
          <button className="ib" type="button" title="Stop" aria-label="Stop" onClick={stopStreaming}>
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
        <button className="send" type="submit" title="Send" aria-label="Send" disabled={composerDisabled}>
          <Icon.up />
        </button>
      </div>
      {attachmentName ? (
        <div className="composer__attachment" role="status">
          <Icon.attach />
          <span className="composer__attachment-name">{attachmentName}</span>
          <button type="button" className="composer__attachment-remove" onClick={clearAttachment} aria-label="Remove attached file">
            Remove
          </button>
        </div>
      ) : null}
      <style jsx>{`
        .composer__attachment {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 8px;
          padding: 6px 10px;
          font-size: 12px;
          color: var(--muted, #888);
          background: rgba(127, 127, 127, 0.08);
          border-radius: 8px;
        }
        .composer__attachment-name {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .composer__attachment-remove {
          background: transparent;
          border: none;
          color: inherit;
          cursor: pointer;
          font-size: 12px;
          padding: 2px 6px;
          border-radius: 6px;
        }
        .composer__attachment-remove:hover {
          background: rgba(127, 127, 127, 0.15);
        }
      `}</style>
    </form>
  );

  const settingsNode = showSettings ? (
    <div className="chat-settings" role="region" aria-label="Chat settings">
      <div>
        <div className="eyebrow">Route</div>
        <h2>Model settings</h2>
        <p className="muted">Provider id is derived from the selected account to avoid invalid routes.</p>
      </div>

      {!loadingAccounts && accounts.length === 0 ? (
        <div className="warning" role="status">
          Chat requires at least one configured provider account. Add one in <Link className="link-button" href="/providers">Providers</Link> before sending messages.
        </div>
      ) : null}

      <div className="chat-settings__fields">
        <label>
          Provider account
          <select aria-label="Provider account" value={accountId} onChange={(event) => handleAccountChange(event.target.value)} disabled={loadingAccounts || isStreaming}>
            <option value="">{loadingAccounts ? "Loading accounts..." : "Choose an account"}</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id} disabled={account.status !== "enabled"}>
                {account.display_name} ({account.provider}, {account.scope}, {account.status})
              </option>
            ))}
          </select>
        </label>
        <div className="route-card">
          <span className="route-card__label">Provider route</span>
          <strong>{selectedAccount?.provider ?? provider}</strong>
          <span>{selectedAccount ? `${selectedAccount.scope} / ${selectedAccount.status}` : "Select an account"}</span>
        </div>
        <label>
          {selectedAccount?.provider === "azure-openai" ? "Azure deployment" : "Model"}
          {selectedModelBindings.length ? (
            <select aria-label="Model binding" value={model} onChange={(event) => setModel(event.target.value)} disabled={isStreaming}>
              <option value="">Choose a bound model</option>
              {selectedModelBindings.map((binding) => (
                <option key={binding.id} value={binding.model ?? ""}>
                  {binding.display_name ?? binding.model}
                </option>
              ))}
            </select>
          ) : (
            <input
              aria-label="Model or Azure deployment name"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="gpt-4o-mini, claude-3-5-sonnet-latest, deployment-name"
              disabled={isStreaming}
            />
          )}
        </label>
      </div>

      {providerMismatch ? (
        <p className="warning chat-warning" role="alert">Selected provider id must match the account provider, or the API will reject the request.</p>
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
            {hour === null ? `Hello, ${displayName}` : `Good ${greeting(hour)}, ${displayName}`}
          </div>
          {composerNode}
          {settingsNode}
        </div>
        <div className="footer">
          <Link href="/">PacketChat {APP_VERSION}</Link> · self-hosted · all traffic stays on your box
        </div>
      </>
    );
  }

  return (
    <>
      <div className="doc" ref={transcriptRef} role="log" aria-live="polite" aria-label={headerTitle}>
        <div className="doc__wrap">
          {settingsNode}
          {messages.map((message) => (
            <Turn
              key={message.id}
              message={message}
              isStreaming={isStreaming}
              isBookmarked={bookmarks.has(message.id)}
              isEditing={editingId === message.id}
              editingDraft={editingDraft}
              onEditingDraftChange={setEditingDraft}
              onCopy={handleCopy}
              onStartEdit={handleStartEdit}
              onCancelEdit={handleCancelEdit}
              onSaveEdit={handleSaveEdit}
              onToggleBookmark={handleToggleBookmark}
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
  isStreaming: boolean;
  isBookmarked: boolean;
  isEditing: boolean;
  editingDraft: string;
  onEditingDraftChange: (value: string) => void;
  onCopy: (content: string) => void;
  onStartEdit: (message: ChatMessage) => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onToggleBookmark: (id: string) => void;
};

function Turn({
  message,
  isStreaming,
  isBookmarked,
  isEditing,
  editingDraft,
  onEditingDraftChange,
  onCopy,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onToggleBookmark
}: TurnProps) {
  const isUser = message.role === "user";
  const placeholder = isStreaming && !isUser && !message.content ? "…" : "";
  const timestamp = formatTimestamp(message.createdAt);
  const showTools = !isUser && !!message.content && !isStreaming;

  return (
    <article className="turn">
      <div className="turn__head">
        <div className={`av ${isUser ? "u" : "a"}`} aria-hidden="true">{isUser ? "OA" : ""}</div>
        <b>{isUser ? "You" : "Claude"}</b>
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
        <div className="turn__body">{renderBody(message.content || placeholder)}</div>
      )}
      {showTools && !isEditing ? (
        <div className="turn__tools">
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
