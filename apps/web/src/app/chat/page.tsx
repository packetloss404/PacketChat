"use client";

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { ProviderId } from "@packetchat/contracts";
import { getAccessToken } from "../../lib/auth-client";
import { apiClient, type Conversation, type ConversationMessage, type ProviderAccount, type ProviderModelBinding } from "../../lib/api-client";
import { Icon } from "../../components/icons";

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

function token() {
  return getAccessToken() ?? "";
}

function normalizedMessages(messages: ChatMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: [{ type: "text", text: message.content }]
  }));
}

function textFromConversationMessage(message: ConversationMessage) {
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  return "";
}

function isChatRole(role: string): role is ChatMessage["role"] {
  return role === "user" || role === "assistant";
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

export default function ChatPage() {
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
  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

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
      <div className="composer__row">
        <button className="ib" type="button" title="Attach" aria-label="Attach" disabled={isStreaming}>
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
            <Icon.dots />
          </button>
        ) : (
          <button className="ib" type="button" title="Voice input" aria-label="Voice input" disabled>
            <Icon.mic />
          </button>
        )}
        <button className="send" type="submit" title="Send" aria-label="Send" disabled={composerDisabled}>
          <Icon.up />
        </button>
      </div>
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
    const hour = new Date().getHours();
    return (
      <>
        <div className="stage">
          <div className="greet">
            <span className="logo" aria-hidden="true" />
            Good {greeting(hour)}, {displayName}
          </div>
          {composerNode}
          {settingsNode}
        </div>
        <div className="footer">
          <Link href="/">PacketChat v0.8.2-rc1</Link> · self-hosted · all traffic stays on your box
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
            <Turn key={message.id} message={message} isStreaming={isStreaming} />
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

function Turn({ message, isStreaming }: { message: ChatMessage; isStreaming: boolean }) {
  const isUser = message.role === "user";
  const placeholder = isStreaming && !isUser && !message.content ? "…" : "";
  const timestamp = message.createdAt
    ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(message.createdAt))
    : "—";
  return (
    <article className="turn">
      <div className="turn__head">
        <div className={`av ${isUser ? "u" : "a"}`} aria-hidden="true">{isUser ? "OA" : ""}</div>
        <b>{isUser ? "You" : "Claude"}</b>
        <span>·</span>
        <span>{timestamp}</span>
      </div>
      <div className="turn__body">{renderBody(message.content || placeholder)}</div>
      {!isUser && message.content ? (
        <div className="turn__tools">
          <button className="ib" type="button" title="Copy" aria-label="Copy">
            <Icon.copy />
          </button>
          <button className="ib" type="button" title="Edit" aria-label="Edit">
            <Icon.edit />
          </button>
          <button className="ib" type="button" title="Bookmark" aria-label="Bookmark">
            <Icon.bookmark />
          </button>
        </div>
      ) : null}
    </article>
  );
}
