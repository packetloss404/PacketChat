"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ProviderId } from "@packetchat/contracts";
import { getAccessToken } from "../../lib/auth-client";
import { apiClient, type Conversation, type ConversationMessage, type ProviderAccount, type ProviderModelBinding } from "../../lib/api-client";
import { ConfirmButton } from "../../components/ui";

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

function formatDate(value?: string) {
  if (!value) return "Not updated yet";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
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
  const [renameDraft, setRenameDraft] = useState("");
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const selectedAccount = useMemo(() => accounts.find((account) => account.id === accountId), [accountId, accounts]);
  const selectedConversation = useMemo(() => conversations.find((conversation) => conversation.id === conversationId), [conversationId, conversations]);
  const selectedModelBindings = useMemo(() => modelBindings.filter((binding) => binding.provider_account_id === accountId && binding.model), [accountId, modelBindings]);
  const composerDisabled = isStreaming || loadingAccounts || !input.trim() || !accountId || !model.trim() || (selectedAccount ? selectedAccount.provider !== provider : false);

  async function loadConversations() {
    const payload = await apiClient.conversations.list();
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
        const [providerPayload, conversationPayload] = await Promise.all([apiClient.providers.list(), apiClient.conversations.list()]);
        if (cancelled) return;

        const nextAccounts = providerPayload.accounts ?? [];
        setAccounts(nextAccounts);
        setModelBindings(providerPayload.modelBindings ?? []);
        setConversations(conversationPayload.conversations ?? []);
        const defaultAccount = nextAccounts.find((account) => account.is_default && account.status === "enabled") ?? nextAccounts.find((account) => account.status === "enabled") ?? nextAccounts[0];
        if (defaultAccount) {
          setAccountId(defaultAccount.id);
          setProvider(defaultAccount.provider);
          const defaultBinding = (providerPayload.modelBindings ?? []).find((binding) => binding.provider_account_id === defaultAccount.id && binding.model);
          setModel(defaultBinding?.model ?? "");
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
    setModel(binding?.model ?? "");
  }

  async function createConversation() {
    if (isStreaming) return;
    try {
      const payload = await apiClient.conversations.create({ title: "New chat" });
      setConversations((current) => [payload.conversation, ...current]);
      setConversationId(payload.conversation.id);
      setRenameDraft(payload.conversation.title);
      setMessages([]);
      setStatus("New conversation ready.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function renameConversation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!conversationId || isStreaming) return;
    const trimmed = renameDraft.trim();
    if (!trimmed) {
      setStatus("Conversation title is required.");
      return;
    }
    try {
      const payload = await apiClient.conversations.update(conversationId, { title: trimmed });
      setConversations((current) => current.map((item) => (item.id === conversationId ? { ...item, ...payload.conversation } : item)));
      setStatus("Conversation renamed.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function archiveConversation() {
    if (!conversationId || isStreaming) return;
    try {
      await apiClient.conversations.update(conversationId, { archived: true });
      setConversations((current) => current.filter((item) => item.id !== conversationId));
      setConversationId("");
      setRenameDraft("");
      setMessages([]);
      setStatus("Conversation archived.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function deleteConversation() {
    if (!conversationId || isStreaming) return;
    try {
      await apiClient.conversations.delete(conversationId);
      setConversations((current) => current.filter((item) => item.id !== conversationId));
      setConversationId("");
      setRenameDraft("");
      setMessages([]);
      setStatus("Conversation deleted.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function selectConversation(nextConversationId: string) {
    if (isStreaming) return;
    setConversationId(nextConversationId);
    const nextConversation = conversations.find((conversation) => conversation.id === nextConversationId);
    setRenameDraft(nextConversation?.title ?? "");
    if (!nextConversationId) {
      setMessages([]);
      return;
    }

    setLoadingConversation(true);
    try {
      const payload = await apiClient.conversations.messages(nextConversationId);
      setMessages(
        (payload.messages ?? [])
          .filter((message) => isChatRole(message.role))
          .map((message) => ({ id: message.id, role: message.role as ChatMessage["role"], content: textFromConversationMessage(message) }))
      );
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingConversation(false);
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
    if (selectedAccount && selectedAccount.provider !== provider) {
      setStatus("Selected provider id must match the selected provider account.");
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

  return (
    <section className="chat-workspace">
      <ChatSidebar
        conversations={conversations}
        conversationId={conversationId}
        isStreaming={isStreaming}
        renameDraft={renameDraft}
        onRenameDraftChange={setRenameDraft}
        onCreateConversation={createConversation}
        onSelectConversation={(id) => void selectConversation(id)}
        onRenameConversation={(event) => void renameConversation(event)}
        onArchiveConversation={() => void archiveConversation()}
        onDeleteConversation={() => void deleteConversation()}
      />

      <main className="chat-main" aria-label="Chat workspace">
        <ChatTopbar conversation={selectedConversation} selectedAccount={selectedAccount} model={model} isStreaming={isStreaming} onStopStreaming={stopStreaming} />
        <ChatTranscript messages={messages} loadingAccounts={loadingAccounts} loadingConversation={loadingConversation} isStreaming={isStreaming} />
        <ChatComposer input={input} isStreaming={isStreaming} disabled={composerDisabled} onInputChange={setInput} onSubmit={(event) => void sendMessage(event)} />
        <ChatStatus status={status} />
      </main>

      <ChatSettingsPanel
        accounts={accounts}
        accountId={accountId}
        selectedAccount={selectedAccount}
        selectedModelBindings={selectedModelBindings}
        provider={provider}
        model={model}
        loadingAccounts={loadingAccounts}
        isStreaming={isStreaming}
        onAccountChange={handleAccountChange}
        onModelChange={setModel}
      />
    </section>
  );
}

function ChatSidebar({
  conversations,
  conversationId,
  isStreaming,
  renameDraft,
  onRenameDraftChange,
  onCreateConversation,
  onSelectConversation,
  onRenameConversation,
  onArchiveConversation,
  onDeleteConversation
}: {
  conversations: Conversation[];
  conversationId: string;
  isStreaming: boolean;
  renameDraft: string;
  onRenameDraftChange: (value: string) => void;
  onCreateConversation: () => void;
  onSelectConversation: (conversationId: string) => void;
  onRenameConversation: (event: FormEvent<HTMLFormElement>) => void;
  onArchiveConversation: () => void;
  onDeleteConversation: () => void;
}) {
  const selected = conversations.find((conversation) => conversation.id === conversationId);
  return (
    <aside className="chat-sidebar" aria-label="Conversations">
      <div className="chat-sidebar__header">
        <div>
          <div className="eyebrow">Chat</div>
          <h1>Conversations</h1>
        </div>
        <button className="button" type="button" onClick={onCreateConversation} disabled={isStreaming}>
          New
        </button>
      </div>

      <div className="chat-thread-list">
        <button className="chat-thread" type="button" aria-pressed={conversationId === ""} onClick={() => onSelectConversation("")} disabled={isStreaming}>
          <span className="chat-thread__title">Start a new conversation</span>
          <span className="chat-thread__meta">Creates on first send</span>
        </button>
        {conversations.map((conversation) => (
          <button className="chat-thread" key={conversation.id} type="button" aria-pressed={conversation.id === conversationId} onClick={() => onSelectConversation(conversation.id)} disabled={isStreaming}>
            <span className="chat-thread__title">{conversation.title}</span>
            <span className="chat-thread__meta">Updated {formatDate(conversation.updated_at)}</span>
          </button>
        ))}
      </div>

      <div className="chat-sidebar__actions">
        {selected ? (
          <form className="chat-rename-form" onSubmit={onRenameConversation}>
            <label>
              Rename active thread
              <input className="input" value={renameDraft} onChange={(event) => onRenameDraftChange(event.target.value)} disabled={isStreaming} />
            </label>
            <button className="button button--ghost" type="submit" disabled={isStreaming || !renameDraft.trim()}>
              Rename
            </button>
          </form>
        ) : (
          <p className="muted">Select a saved conversation to rename, archive, or delete it.</p>
        )}
        <div className="chat-thread-actions">
          <ConfirmButton className="button button--ghost" message="Archive selected conversation?" confirmLabel="Archive" disabled={!selected || isStreaming} onConfirm={onArchiveConversation}>
            Archive
          </ConfirmButton>
          <ConfirmButton className="button button--danger" message="Delete selected conversation?" confirmLabel="Delete" disabled={!selected || isStreaming} onConfirm={onDeleteConversation}>
            Delete
          </ConfirmButton>
        </div>
      </div>
    </aside>
  );
}

function ChatTopbar({ conversation, selectedAccount, model, isStreaming, onStopStreaming }: { conversation?: Conversation; selectedAccount?: ProviderAccount; model: string; isStreaming: boolean; onStopStreaming: () => void }) {
  return (
    <header className="chat-main__header">
      <div>
        <div className="eyebrow">Workspace</div>
        <h2>{conversation?.title ?? "New conversation"}</h2>
        <p className="muted">
          {selectedAccount ? `${selectedAccount.display_name} / ${model || "No model selected"}` : "No provider selected"}
        </p>
      </div>
      <button className="button button--ghost" type="button" onClick={onStopStreaming} disabled={!isStreaming}>
        Stop
      </button>
    </header>
  );
}

function ChatSettingsPanel({
  accounts,
  accountId,
  selectedAccount,
  selectedModelBindings,
  provider,
  model,
  loadingAccounts,
  isStreaming,
  onAccountChange,
  onModelChange
}: {
  accounts: ProviderAccount[];
  accountId: string;
  selectedAccount?: ProviderAccount;
  selectedModelBindings: ProviderModelBinding[];
  provider: ProviderId;
  model: string;
  loadingAccounts: boolean;
  isStreaming: boolean;
  onAccountChange: (accountId: string) => void;
  onModelChange: (model: string) => void;
}) {
  const modelLabel = selectedAccount?.provider === "azure-openai" ? "Azure deployment" : "Model";
  return (
    <aside className="chat-settings card" aria-label="Chat settings">
      <div>
        <div className="eyebrow">Route</div>
        <h2>Model settings</h2>
        <p className="muted">Provider id is derived from the selected account to avoid invalid routes.</p>
      </div>

      {!loadingAccounts && accounts.length === 0 ? (
        <div className="warning" role="status">
          Chat requires at least one configured provider account. Add one in <a className="link-button" href="/providers">Providers</a> before sending messages.
        </div>
      ) : null}

      <div className="chat-settings__fields">
        <label>
          Provider account
          <select aria-label="Provider account" value={accountId} onChange={(event) => onAccountChange(event.target.value)} disabled={loadingAccounts || isStreaming}>
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
          {modelLabel}
          {selectedModelBindings.length ? (
            <select aria-label="Model binding" value={model} onChange={(event) => onModelChange(event.target.value)} disabled={isStreaming}>
              <option value="">Choose a bound model</option>
              {selectedModelBindings.map((binding) => (
                <option key={binding.id} value={binding.model ?? ""}>
                  {binding.display_name ?? binding.model}
                </option>
              ))}
            </select>
          ) : (
            <input className="input" aria-label="Model or Azure deployment name" value={model} onChange={(event) => onModelChange(event.target.value)} placeholder="gpt-4o-mini, claude-3-5-sonnet-latest, deployment-name" disabled={isStreaming} />
          )}
        </label>
      </div>

      {selectedAccount && selectedAccount.provider !== provider ? (
        <p className="warning chat-warning" role="alert">Selected provider id must match the account provider, or the API will reject the request.</p>
      ) : null}
    </aside>
  );
}

function ChatTranscript({ messages, loadingAccounts, loadingConversation, isStreaming }: { messages: ChatMessage[]; loadingAccounts: boolean; loadingConversation: boolean; isStreaming: boolean }) {
  return (
    <section className="chat-transcript" role="log" aria-live="polite" aria-relevant="additions text" aria-labelledby="chat-transcript-heading">
      <h2 className="sr-only" id="chat-transcript-heading">Conversation transcript</h2>
      {loadingAccounts ? <p className="loading-state">Loading provider accounts and conversations...</p> : null}
      {loadingConversation ? <p className="loading-state">Loading conversation messages...</p> : null}
      {!loadingAccounts && !loadingConversation && messages.length === 0 ? <p className="empty-state">Choose a route and send a message. Saved conversations appear in the left rail.</p> : null}
      {messages.map((message) => (
        <ChatMessageBubble isStreaming={isStreaming} key={message.id} message={message} />
      ))}
    </section>
  );
}

function ChatMessageBubble({ message, isStreaming }: { message: ChatMessage; isStreaming: boolean }) {
  const author = message.role === "user" ? "You" : "Assistant";
  return (
    <article className={`chat-message chat-message--${message.role}`} aria-label={`Message from ${author.toLowerCase()}`}>
      <div className="chat-message__author">{author}</div>
      <p className="chat-message__content">{message.content || (isStreaming && message.role === "assistant" ? "Thinking..." : "")}</p>
    </article>
  );
}

function ChatComposer({ input, isStreaming, disabled, onInputChange, onSubmit }: { input: string; isStreaming: boolean; disabled: boolean; onInputChange: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return (
    <form className="chat-composer" onSubmit={onSubmit}>
      <textarea className="chat-composer__input" aria-label="Message" value={input} onChange={(event) => onInputChange(event.target.value)} placeholder="Type a message..." rows={4} disabled={isStreaming} />
      <div className="chat-composer__actions">
        <button className="button" type="submit" disabled={disabled}>
          {isStreaming ? "Streaming..." : "Send"}
        </button>
      </div>
    </form>
  );
}

function ChatStatus({ status }: { status: string }) {
  if (!status) return null;
  return <p className={isErrorStatus(status) ? "error-state chat-status" : "notice chat-status"} role={isErrorStatus(status) ? "alert" : "status"}>{status}</p>;
}
