import { randomUUID } from "node:crypto";
import { authenticateRequest } from "@packetchat/auth";
import {
  chatRequestControlsSchema,
  normalizedChatRequestSchema,
  type ConversationStreamEvent,
  type ConversationUpdatedStreamEvent,
  type NormalizedChatRequest,
  type NormalizedMessage,
  type NormalizedUsage,
  type StreamEvent
} from "@packetchat/contracts";
import { getSql } from "@packetchat/db";
import { logger } from "@packetchat/observability";
import { getProviderAdapter } from "@packetchat/providers";
import { attachmentInputsFromRows, buildAttachmentContext } from "../../../lib/chat-files/context";
import { jsonError } from "../../../lib/http";
import { getEnabledModelBindingForRuntime, getProviderAccountForRuntime } from "../../../lib/providers";
import { chatRateLimit } from "../../../lib/rate-limit";
import { recordUsage } from "../../../lib/usage";

type ChatSetup = {
  conversationId: string;
  runId: string;
  userMessageId: string;
  assistantMessageId: string;
  parentMessageId: string | null;
};

class ChatRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ChatRequestError";
    this.status = status;
  }
}

function messageText(message: NormalizedMessage) {
  return message.content
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function titleFromMessage(message: NormalizedMessage) {
  const text = messageText(message).replace(/\s+/g, " ");
  return text ? text.slice(0, 80) : "New chat";
}

function toJsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

function publicChatError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/provider account not found|provider mismatch|conversation not found/i.test(message)) return message;
  return "Chat failed. Check the selected model/provider settings and try again.";
}

function withMessageId(event: StreamEvent, messageId: string): StreamEvent {
  if (event.type === "message_start" || event.type === "message_end") return { ...event, messageId };
  return event;
}

function sanitizeStreamEvent(event: StreamEvent): StreamEvent {
  if (event.type !== "error") return event;
  return {
    ...event,
    error: {
      ...event.error,
      message: publicChatError(event.error.message)
    }
  };
}

export async function POST(request: Request) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);
  const rateLimited = await chatRateLimit(request, user.id);
  if (rateLimited) return rateLimited;

  const body = await request.json().catch(() => null);
  if (!body?.providerAccountId) return jsonError("providerAccountId is required", 400);

  const parsed = normalizedChatRequestSchema.safeParse(body);
  if (!parsed.success) return jsonError("Invalid chat request", 400, parsed.error.flatten());

  const controls = chatRequestControlsSchema.safeParse(body ?? {});
  if (!controls.success) return jsonError("Invalid chat request", 400, controls.error.flatten());

  const account = await getProviderAccountForRuntime(String(body.providerAccountId));
  if (!account) return jsonError("Provider account not found", 404);
  if (account.provider !== parsed.data.provider) return jsonError("Provider mismatch", 400);
  const modelBinding = await getEnabledModelBindingForRuntime({
    accountId: String(body.providerAccountId),
    provider: account.provider,
    model: parsed.data.model
  });
  if (!modelBinding) return jsonError("Selected model is disabled or no longer available for this provider account", 400);

  const sql = getSql();
  const lastUserMessage = [...parsed.data.messages].reverse().find((message) => message.role === "user");
  if (!lastUserMessage) return jsonError("At least one user message is required", 400);

  const attachmentIds = [...new Set(controls.data.attachmentIds ?? [])];
  let attachmentContextText = "";
  if (attachmentIds.length > 0) {
    const rows = await sql<{ id: string; file_name: string; mime_type: string | null; extracted_text: string | null }[]>`
      select id, file_name, mime_type, metadata->>'extractedText' as extracted_text
      from attachments
      where id = any(${attachmentIds})
        and owner_user_id = ${user.id}
    `;
    if (rows.length !== attachmentIds.length) return jsonError("One or more attachments were not found", 400);

    const context = buildAttachmentContext(attachmentInputsFromRows(rows.map((row) => ({
      id: row.id,
      fileName: row.file_name,
      mimeType: row.mime_type,
      extractedText: row.extracted_text
    }))));
    attachmentContextText = context.contextText;
  }

  // Attachment text is injected as an extra system message for this turn only;
  // it is never persisted as a tree node, mirroring the agent file-context path.
  const providerRequest: NormalizedChatRequest = attachmentContextText
    ? {
        ...parsed.data,
        messages: [
          { role: "system", content: [{ type: "text", text: attachmentContextText }] },
          ...parsed.data.messages
        ]
      }
    : parsed.data;

  // The injected attachment context is for the live provider call only. Storing
  // the full request would copy extracted file text into conversation_runs.request
  // and the usage estimate, so the persisted request keeps the caller's original
  // messages; the user message metadata's attachmentIds remains the reference.
  const persistedRequest: NormalizedChatRequest = parsed.data;

  const conversationId =
    typeof controls.data.conversationId === "string" && controls.data.conversationId.trim() ? controls.data.conversationId.trim() : null;
  const explicitParentId =
    typeof controls.data.parentMessageId === "string" && controls.data.parentMessageId.trim() ? controls.data.parentMessageId.trim() : null;
  const editMessageId = typeof controls.data.editMessageId === "string" && controls.data.editMessageId.trim() ? controls.data.editMessageId.trim() : null;
  const regenerate = controls.data.regenerate === true;

  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();

  const setup = await sql
    .begin(async (tx): Promise<ChatSetup> => {
      let conversation = conversationId
        ? (
            await tx<{ id: string; title: string; active_leaf_message_id: string | null }[]>`
              select id, title, active_leaf_message_id
              from conversations
              where id = ${conversationId} and owner_user_id = ${user.id} and archived_at is null
              limit 1
            `
          )[0]
        : null;

      if (conversationId && !conversation) throw new ChatRequestError("Conversation not found", 404);

      if (!conversation) {
        const rows = await tx<{ id: string; title: string; active_leaf_message_id: string | null }[]>`
          insert into conversations (owner_user_id, title)
          values (${user.id}, ${titleFromMessage(lastUserMessage)})
          returning id, title, active_leaf_message_id
        `;
        conversation = rows[0]!;
      }

      // `assistantParentId` is the user message the assistant reply hangs under.
      // `newMessageParentId` is the parent recorded for the inserted user
      // message, which is null only for the first message of a conversation.
      let assistantParentId: string;
      let newMessageParentId: string | null = null;
      let insertedUserMessage = true;

      if (regenerate) {
        if (!explicitParentId) throw new ChatRequestError("parentMessageId is required to regenerate", 400);
        const target = (
          await tx<{ id: string; role: string; parent_message_id: string | null }[]>`
            select id, role, parent_message_id
            from messages
            where id = ${explicitParentId} and conversation_id = ${conversation.id} and owner_user_id = ${user.id}
            limit 1
          `
        )[0];
        if (!target) throw new ChatRequestError("Message not found", 404);

        if (target.role === "user") {
          assistantParentId = target.id;
        } else if (target.role === "assistant") {
          if (!target.parent_message_id) throw new ChatRequestError("Message not found", 404);
          const parent = (
            await tx<{ id: string; role: string }[]>`
              select id, role
              from messages
              where id = ${target.parent_message_id} and conversation_id = ${conversation.id} and owner_user_id = ${user.id}
              limit 1
            `
          )[0];
          if (!parent || parent.role !== "user") throw new ChatRequestError("Message not found", 404);
          assistantParentId = parent.id;
        } else {
          throw new ChatRequestError("Message not found", 404);
        }
        insertedUserMessage = false;
      } else if (editMessageId) {
        const edited = (
          await tx<{ id: string; role: string; parent_message_id: string | null }[]>`
            select id, role, parent_message_id
            from messages
            where id = ${editMessageId} and conversation_id = ${conversation.id} and owner_user_id = ${user.id}
            limit 1
          `
        )[0];
        if (!edited || edited.role !== "user") throw new ChatRequestError("Message not found", 404);
        newMessageParentId = edited.parent_message_id;
        assistantParentId = userMessageId;
      } else {
        if (explicitParentId) {
          const parent = (
            await tx<{ id: string }[]>`
              select id from messages
              where id = ${explicitParentId} and conversation_id = ${conversation.id} and owner_user_id = ${user.id}
              limit 1
            `
          )[0];
          if (!parent) throw new ChatRequestError("Message not found", 404);
          newMessageParentId = explicitParentId;
        } else {
          newMessageParentId = conversation.active_leaf_message_id ?? null;
        }
        assistantParentId = userMessageId;
      }

      if (insertedUserMessage) {
        await tx`
          insert into messages (id, conversation_id, owner_user_id, role, content, metadata, parent_message_id)
          values (
            ${userMessageId},
            ${conversation.id},
            ${user.id},
            ${lastUserMessage.role},
            ${JSON.stringify(lastUserMessage.content)}::jsonb,
            ${JSON.stringify({
              providerAccountId: body.providerAccountId,
              model: parsed.data.model,
              ...(attachmentIds.length > 0 ? { attachmentIds } : {})
            })}::jsonb,
            ${newMessageParentId}
          )
        `;

        // Attachments are uploaded before the conversation/message exist, so
        // they start with a null owner. Adopting them here keeps the message
        // relation authoritative and stops the orphan cleanup from treating a
        // referenced chat attachment as unreferenced.
        if (attachmentIds.length > 0) {
          await tx`
            update attachments
            set conversation_id = ${conversation.id},
                message_id = ${userMessageId}
            where id = any(${attachmentIds})
              and owner_user_id = ${user.id}
          `;
        }
      }

      const runs = await tx<{ id: string }[]>`
        insert into conversation_runs (conversation_id, owner_user_id, provider_account_id, model, status, request, started_at)
        values (${conversation.id}, ${user.id}, ${String(body.providerAccountId)}, ${parsed.data.model}, 'running', ${JSON.stringify(toJsonValue(persistedRequest))}::jsonb, now())
        returning id
      `;

      // Until the assistant reply is persisted the newly created (or reused)
      // user message is the active leaf; the stream's finally block moves the
      // leaf to the assistant message once it exists.
      await tx`
        update conversations
        set title = case when title = 'New chat' then ${titleFromMessage(lastUserMessage)} else title end,
            active_leaf_message_id = ${assistantParentId},
            updated_at = now()
        where id = ${conversation.id}
      `;

      return {
        conversationId: conversation.id,
        runId: runs[0]!.id,
        userMessageId: assistantParentId,
        assistantMessageId,
        parentMessageId: newMessageParentId
      };
    })
    .catch((error) => {
      if (error instanceof ChatRequestError) return { error };
      throw error;
    });

  if ("error" in setup) return jsonError(setup.error.message, setup.error.status);

  const adapter = getProviderAdapter(account.provider);
  const encoder = new TextEncoder();
  const streamAbortController = new AbortController();
  const abortStream = () => streamAbortController.abort();
  request.signal.addEventListener("abort", abortStream, { once: true });

  const stream = new ReadableStream({
    async start(controller) {
      let assistantText = "";
      let finishReason: string | null = null;
      let failedError: string | null = null;
      let providerUsage: NormalizedUsage | null = null;

      const send = (event: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Client disconnected; there is nothing left to deliver.
        }
      };

      const openingEvent: ConversationStreamEvent = {
        type: "conversation",
        conversationId: setup.conversationId,
        runId: setup.runId,
        userMessageId: setup.userMessageId,
        assistantMessageId: setup.assistantMessageId,
        parentMessageId: setup.parentMessageId
      };
      send(openingEvent);

      try {
        for await (const event of adapter.streamChat(account, providerRequest, { signal: streamAbortController.signal })) {
          if (event.type === "text_delta") assistantText += event.text;
          if (event.type === "message_end") {
            finishReason = event.finishReason;
            providerUsage = event.usage ?? null;
          }
          const outboundEvent = withMessageId(sanitizeStreamEvent(event), setup.assistantMessageId);
          if (outboundEvent.type === "error") failedError = outboundEvent.error.message;
          send(outboundEvent);
        }
      } catch (error) {
        logger.warn("Chat stream failed", { runId: setup.runId, error: error instanceof Error ? error.message : String(error) });
        failedError = publicChatError(error);
        send({ type: "error", error: { code: "chat_failed", message: failedError, retryable: false } } satisfies StreamEvent);
      } finally {
        const activeLeafMessageId = assistantText ? setup.assistantMessageId : setup.userMessageId;
        await sql.begin(async (tx) => {
          if (assistantText) {
            await tx`
              insert into messages (id, conversation_id, owner_user_id, role, content, metadata, parent_message_id)
              values (
                ${setup.assistantMessageId},
                ${setup.conversationId},
                ${user.id},
                'assistant',
                ${JSON.stringify([{ type: "text", text: assistantText }])}::jsonb,
                ${JSON.stringify({ conversationRunId: setup.runId, providerAccountId: body.providerAccountId, model: parsed.data.model })}::jsonb,
                ${setup.userMessageId}
              )
            `;
          }

          await tx`
            update conversation_runs
            set status = ${failedError ? "failed" : "completed"},
                response = ${JSON.stringify({ finishReason, content: assistantText })}::jsonb,
                ended_at = now(),
                error_message = ${failedError}
            where id = ${setup.runId} and owner_user_id = ${user.id}
          `;

          await tx`
            update conversations
            set active_leaf_message_id = ${activeLeafMessageId},
                updated_at = now()
            where id = ${setup.conversationId} and owner_user_id = ${user.id}
          `;
        });
        if (assistantText) {
          await recordUsage({
            ownerUserId: user.id,
            providerAccountId: String(body.providerAccountId),
            conversationRunId: setup.runId,
            provider: account.provider,
            model: parsed.data.model,
            request: persistedRequest,
            outputText: assistantText,
            providerUsage
          }).catch((error) => {
            logger.warn("Failed to record chat usage", { runId: setup.runId, error: error instanceof Error ? error.message : String(error) });
          });
        }

        const updatedEvent: ConversationUpdatedStreamEvent = {
          type: "conversation_updated",
          conversationId: setup.conversationId,
          activeLeafMessageId,
          assistantMessageId: assistantText ? setup.assistantMessageId : null
        };
        send(updatedEvent);

        try {
          controller.close();
        } catch {
          // Stream already closed by the client.
        }
        request.signal.removeEventListener("abort", abortStream);
      }
    },
    cancel() {
      streamAbortController.abort();
      request.signal.removeEventListener("abort", abortStream);
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    }
  });
}
