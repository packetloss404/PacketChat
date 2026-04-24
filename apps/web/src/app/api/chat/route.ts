import { authenticateRequest } from "@packetchat/auth";
import { normalizedChatRequestSchema, type NormalizedMessage, type NormalizedUsage, type StreamEvent } from "@packetchat/contracts";
import { getSql } from "@packetchat/db";
import { getProviderAdapter } from "@packetchat/providers";
import { jsonError } from "../../../lib/http";
import { getProviderAccountForRuntime } from "../../../lib/providers";
import { chatRateLimit } from "../../../lib/rate-limit";
import { recordUsage } from "../../../lib/usage";

function messageText(message: NormalizedMessage) {
  return message.content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
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

export async function POST(request: Request) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);
  const rateLimited = await chatRateLimit(request, user.id);
  if (rateLimited) return rateLimited;

  const body = await request.json().catch(() => null);
  if (!body?.providerAccountId) return jsonError("providerAccountId is required", 400);

  const parsed = normalizedChatRequestSchema.safeParse(body);
  if (!parsed.success) return jsonError("Invalid chat request", 400, parsed.error.flatten());

  const account = await getProviderAccountForRuntime(String(body.providerAccountId), user.id);
  if (!account) return jsonError("Provider account not found", 404);
  if (account.provider !== parsed.data.provider) return jsonError("Provider mismatch", 400);

  const sql = getSql();
  const lastUserMessage = [...parsed.data.messages].reverse().find((message) => message.role === "user");
  if (!lastUserMessage) return jsonError("At least one user message is required", 400);

  const conversationId = typeof body.conversationId === "string" && body.conversationId.trim() ? body.conversationId.trim() : null;
  const setup = await sql.begin(async (tx) => {
    let conversation = conversationId
      ? (
          await tx<{ id: string; title: string }[]>`
            select id, title
            from conversations
            where id = ${conversationId} and owner_user_id = ${user.id} and archived_at is null
            limit 1
          `
        )[0]
      : null;

    if (conversationId && !conversation) throw new Error("Conversation not found");

    if (!conversation) {
      const rows = await tx<{ id: string; title: string }[]>`
        insert into conversations (owner_user_id, title)
        values (${user.id}, ${titleFromMessage(lastUserMessage)})
        returning id, title
      `;
      conversation = rows[0]!;
    }

    await tx`
      insert into messages (conversation_id, owner_user_id, role, content, metadata)
      values (${conversation.id}, ${user.id}, ${lastUserMessage.role}, ${JSON.stringify(lastUserMessage.content)}::jsonb, ${JSON.stringify({ providerAccountId: body.providerAccountId, model: parsed.data.model })}::jsonb)
    `;

    const runs = await tx<{ id: string }[]>`
      insert into conversation_runs (conversation_id, owner_user_id, provider_account_id, model, status, request, started_at)
      values (${conversation.id}, ${user.id}, ${String(body.providerAccountId)}, ${parsed.data.model}, 'running', ${JSON.stringify(toJsonValue(parsed.data))}::jsonb, now())
      returning id
    `;

    await tx`
      update conversations
      set title = case when title = 'New chat' then ${titleFromMessage(lastUserMessage)} else title end,
          updated_at = now()
      where id = ${conversation.id}
    `;

    return { conversationId: conversation.id, runId: runs[0]!.id };
  }).catch((error) => {
    if (error instanceof Error && error.message === "Conversation not found") return null;
    throw error;
  });

  if (!setup) return jsonError("Conversation not found", 404);

  const adapter = getProviderAdapter(account.provider);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let assistantText = "";
      let finishReason: string | null = null;
      let failedError: string | null = null;
      let providerUsage: NormalizedUsage | null = null;

      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "conversation", conversationId: setup.conversationId, runId: setup.runId })}\n\n`));

      try {
        for await (const event of adapter.streamChat(account, parsed.data)) {
          if (event.type === "text_delta") assistantText += event.text;
          if (event.type === "message_end") {
            finishReason = event.finishReason;
            providerUsage = event.usage ?? null;
          }
          if (event.type === "error") failedError = event.error.message;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      } catch (error) {
        failedError = error instanceof Error ? error.message : String(error);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: { code: "chat_failed", message: failedError, retryable: false } } satisfies StreamEvent)}\n\n`));
      } finally {
        await sql.begin(async (tx) => {
          if (assistantText) {
            await tx`
              insert into messages (conversation_id, owner_user_id, role, content, metadata)
              values (${setup.conversationId}, ${user.id}, 'assistant', ${JSON.stringify([{ type: "text", text: assistantText }])}::jsonb, ${JSON.stringify({ conversationRunId: setup.runId, providerAccountId: body.providerAccountId, model: parsed.data.model })}::jsonb)
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
            update conversations set updated_at = now() where id = ${setup.conversationId} and owner_user_id = ${user.id}
          `;
        });
        if (assistantText) {
          await recordUsage({
            ownerUserId: user.id,
            providerAccountId: String(body.providerAccountId),
            conversationRunId: setup.runId,
            provider: account.provider,
            model: parsed.data.model,
            request: parsed.data,
            outputText: assistantText,
            providerUsage
          }).catch(() => undefined);
        }
        controller.close();
      }
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
