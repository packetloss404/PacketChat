"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ProviderId } from "@packetchat/contracts";
import { getAccessToken } from "../../lib/auth-client";

type ProviderAccount = {
  id: string;
  provider: ProviderId;
  scope: "global" | "user";
  owner_user_id?: string | null;
  display_name: string;
  base_url?: string | null;
  api_version?: string | null;
  region?: string | null;
  status: string;
  is_default: boolean;
};

type ModelBinding = {
  id: string;
  provider_account_id: string;
  model: string | null;
  display_name: string | null;
};

type Conversation = {
  id: string;
  title: string;
  updated_at: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type StreamEvent =
  | { type: "conversation"; conversationId: string; runId: string }
  | { type: "message_start"; responseId: string }
  | { type: "text_delta"; text: string }
  | { type: "message_end"; finishReason: string }
  | { type: "error"; error: { message?: string; code?: string } };

const providerIds: ProviderId[] = ["openai-compatible", "azure-openai", "anthropic", "perplexity", "minimax"];

function token() {
  return getAccessToken() ?? "";
}

function normalizedMessages(messages: ChatMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: [{ type: "text", text: message.content }]
  }));
}

export default function ChatPage() {
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [modelBindings, setModelBindings] = useState<ModelBinding[]>([]);
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
  const abortRef = useRef<AbortController | null>(null);

  const selectedAccount = useMemo(() => accounts.find((account) => account.id === accountId), [accountId, accounts]);
  const selectedModelBindings = useMemo(() => modelBindings.filter((binding) => binding.provider_account_id === accountId && binding.model), [accountId, modelBindings]);

  async function apiJson<T>(path: string, options: RequestInit = {}) {
    const accessToken = token();
    if (!accessToken) throw new Error("No access token found in localStorage. Sign in before chatting.");

    const response = await fetch(path, {
      ...options,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers
      }
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message ?? payload?.error ?? `Request failed with ${response.status}`);
    return payload as T;
  }

  async function loadConversations() {
    const payload = await apiJson<{ conversations: Conversation[] }>("/api/conversations");
    setConversations(payload.conversations ?? []);
  }

  useEffect(() => {
    const accessToken = token();
    if (!accessToken) {
      setStatus("No access token found in localStorage. Sign in before chatting.");
      setLoadingAccounts(false);
      return;
    }

    let cancelled = false;
    async function loadInitialData() {
      setLoadingAccounts(true);
      setStatus("");
      try {
        const [providerPayload, conversationPayload] = await Promise.all([
          apiJson<{ accounts: ProviderAccount[]; modelBindings?: ModelBinding[] }>("/api/providers"),
          apiJson<{ conversations: Conversation[] }>("/api/conversations")
        ]);
        if (cancelled) return;

        const nextAccounts = providerPayload.accounts ?? [];
        setAccounts(nextAccounts);
        setModelBindings(providerPayload.modelBindings ?? []);
        setConversations(conversationPayload.conversations ?? []);
        const defaultAccount = nextAccounts.find((account) => account.is_default) ?? nextAccounts[0];
        if (defaultAccount) {
          setAccountId(defaultAccount.id);
          setProvider(defaultAccount.provider);
          const defaultBinding = (providerPayload.modelBindings ?? []).find((binding) => binding.provider_account_id === defaultAccount.id && binding.model);
          if (defaultBinding?.model) setModel(defaultBinding.model);
        } else {
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

  function updateAssistantMessage(id: string, updater: (content: string) => string) {
    setMessages((current) => current.map((message) => (message.id === id ? { ...message, content: updater(message.content) } : message)));
  }

  function handleAccountChange(nextAccountId: string) {
    setAccountId(nextAccountId);
    const nextAccount = accounts.find((account) => account.id === nextAccountId);
    if (nextAccount) setProvider(nextAccount.provider);
    const binding = modelBindings.find((item) => item.provider_account_id === nextAccountId && item.model);
    if (binding?.model) setModel(binding.model);
  }

  async function createConversation() {
    if (isStreaming) return;
    try {
      const payload = await apiJson<{ conversation: Conversation }>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "New chat" })
      });
      setConversations((current) => [payload.conversation, ...current]);
      setConversationId(payload.conversation.id);
      setMessages([]);
      setStatus("New conversation ready.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function renameConversation() {
    if (!conversationId || isStreaming) return;
    const conversation = conversations.find((item) => item.id === conversationId);
    const title = window.prompt("Rename conversation", conversation?.title ?? "");
    if (title == null) return;
    const trimmed = title.trim();
    if (!trimmed) {
      setStatus("Conversation title is required.");
      return;
    }
    try {
      const payload = await apiJson<{ conversation: Conversation }>(`/api/conversations/${conversationId}`, {
        method: "PATCH",
        body: JSON.stringify({ title: trimmed })
      });
      setConversations((current) => current.map((item) => (item.id === conversationId ? { ...item, ...payload.conversation } : item)));
      setStatus("Conversation renamed.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function archiveConversation() {
    if (!conversationId || isStreaming || !window.confirm("Archive this conversation?")) return;
    try {
      await apiJson(`/api/conversations/${conversationId}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: true })
      });
      setConversations((current) => current.filter((item) => item.id !== conversationId));
      setConversationId("");
      setMessages([]);
      setStatus("Conversation archived.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function deleteConversation() {
    if (!conversationId || isStreaming || !window.confirm("Delete this conversation and its messages? This cannot be undone.")) return;
    try {
      await apiJson(`/api/conversations/${conversationId}`, { method: "DELETE" });
      setConversations((current) => current.filter((item) => item.id !== conversationId));
      setConversationId("");
      setMessages([]);
      setStatus("Conversation deleted.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function selectConversation(nextConversationId: string) {
    if (isStreaming) return;
    setConversationId(nextConversationId);
    if (!nextConversationId) {
      setMessages([]);
      return;
    }

    try {
      const payload = await apiJson<{ messages: Array<{ id: string; role: ChatMessage["role"]; text: string }> }>(`/api/conversations/${nextConversationId}/messages`);
      setMessages((payload.messages ?? []).filter((message) => message.role === "user" || message.role === "assistant").map((message) => ({ id: message.id, role: message.role, content: message.text })));
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = input.trim();
    const accessToken = token();
    if (!content || isStreaming) return;
    if (!accessToken) {
      setStatus("No access token found in localStorage. Sign in before chatting.");
      return;
    }
    if (!accountId) {
      setStatus("Choose a provider account before sending a message.");
      return;
    }
    if (!model.trim()) {
      setStatus("Enter the provider model or Azure deployment name before sending a message.");
      return;
    }

    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content };
    const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "" };
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
            const event = JSON.parse(line.slice(5).trim()) as StreamEvent;
            if (event.type === "conversation") {
              setConversationId(event.conversationId);
            }
            if (event.type === "text_delta") {
              updateAssistantMessage(assistantMessage.id, (current) => current + event.text);
            }
            if (event.type === "message_end") {
              setStatus(`Finished: ${event.finishReason}`);
            }
            if (event.type === "error") {
              throw new Error(event.error.message ?? event.error.code ?? "Provider stream failed");
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

  return (
    <section className="chat-page card">
      <div className="chat-header">
        <div>
          <div className="eyebrow">Chat</div>
          <h1>Provider chat</h1>
          <p className="muted">Conversations, messages, and provider runs are persisted for your account.</p>
        </div>
        <div className="chat-header-actions">
          <button className="button button--ghost" type="button" onClick={createConversation} disabled={isStreaming}>
            New chat
          </button>
          <button className="button" type="button" onClick={stopStreaming} disabled={!isStreaming}>
            Stop
          </button>
        </div>
      </div>

      {!loadingAccounts && accounts.length === 0 ? (
        <div className="warning" role="status">
          Chat requires at least one configured provider account with a valid key. Add one in <a className="link-button" href="/providers">Providers</a> before sending messages.
        </div>
      ) : null}

      <label className="chat-conversation-select">
        Conversation
        <select aria-label="Conversation" value={conversationId} onChange={(event) => selectConversation(event.target.value)} disabled={isStreaming}>
          <option value="">Start a new conversation on send</option>
          {conversations.map((conversation) => (
            <option key={conversation.id} value={conversation.id}>
              {conversation.title}
            </option>
          ))}
        </select>
      </label>

      <div className="chat-conversation-actions">
        <button className="button button--ghost" type="button" onClick={renameConversation} disabled={!conversationId || isStreaming}>
          Rename
        </button>
        <button className="button button--ghost" type="button" onClick={archiveConversation} disabled={!conversationId || isStreaming}>
          Archive
        </button>
        <button className="button button--ghost" type="button" onClick={deleteConversation} disabled={!conversationId || isStreaming}>
          Delete
        </button>
      </div>

      <div className="chat-controls">
        <label>
          Provider account
          <select aria-label="Provider account" value={accountId} onChange={(event) => handleAccountChange(event.target.value)} disabled={loadingAccounts || isStreaming}>
            <option value="">{loadingAccounts ? "Loading accounts..." : "Choose an account"}</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.display_name} ({account.provider}, {account.scope})
              </option>
            ))}
          </select>
        </label>
        <label>
          Provider id
          <select aria-label="Provider id" value={provider} onChange={(event) => setProvider(event.target.value as ProviderId)} disabled={isStreaming}>
            {providerIds.map((providerId) => (
              <option key={providerId} value={providerId}>
                {providerId}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model
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
            <input className="input" aria-label="Model or Azure deployment name" value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4o-mini, claude-3-5-sonnet-latest, deployment-name" disabled={isStreaming} />
          )}
        </label>
      </div>

      {selectedAccount && selectedAccount.provider !== provider ? (
        <p className="warning chat-warning" role="alert">Selected provider id must match the account provider, or the API will reject the request.</p>
      ) : null}

      <div className="chat-transcript" aria-live="polite">
        {loadingAccounts ? <p className="loading-state">Loading provider accounts and conversations...</p> : null}
        {!loadingAccounts && messages.length === 0 ? <p className="empty-state">Choose an account, enter a model, and send a message to start streaming.</p> : null}
        {messages.map((message) => (
          <article className={`chat-message ${message.role}`} key={message.id}>
            <strong>{message.role === "user" ? "You" : "Assistant"}</strong>
            <p>{message.content || (isStreaming && message.role === "assistant" ? "Thinking..." : "")}</p>
          </article>
        ))}
      </div>

      <form className="chat-composer" onSubmit={sendMessage}>
        <textarea aria-label="Message" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Type a message..." rows={4} disabled={isStreaming} />
        <button className="button" type="submit" disabled={isStreaming || !input.trim()}>
          {isStreaming ? "Streaming..." : "Send"}
        </button>
      </form>

      {status ? <p className={status.toLowerCase().includes("error") || status.toLowerCase().includes("no access") ? "error-state chat-status" : "notice chat-status"} role="status">{status}</p> : null}
    </section>
  );
}
