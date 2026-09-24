import { z } from "zod";

export const providerIdSchema = z.enum([
  "openai-compatible",
  "azure-openai",
  "anthropic",
  "perplexity",
  "minimax"
]);

export type ProviderId = z.infer<typeof providerIdSchema>;

export const contentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() })
]);

export type ContentPart = z.infer<typeof contentPartSchema>;

export const normalizedMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.array(contentPartSchema),
  toolCallId: z.string().optional(),
  name: z.string().optional()
});

export type NormalizedMessage = z.infer<typeof normalizedMessageSchema>;

export const normalizedChatRequestSchema = z.object({
  provider: providerIdSchema,
  model: z.string().min(1),
  messages: z.array(normalizedMessageSchema),
  stream: z.boolean().default(true),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  providerHints: z.record(z.unknown()).optional()
});

export type NormalizedChatRequest = z.infer<typeof normalizedChatRequestSchema>;

/**
 * App-level control fields accepted by `POST /api/chat` alongside a normalized
 * model request. They are kept out of `normalizedChatRequestSchema` so the
 * provider adapters only ever see the provider-facing shape.
 */
export const chatRequestControlsSchema = z.object({
  conversationId: z.string().nullable().optional(),
  parentMessageId: z.string().nullable().optional(),
  editMessageId: z.string().optional(),
  regenerate: z.boolean().optional(),
  /** Chat-scoped attachment ids whose extracted text is injected for this turn. */
  attachmentIds: z.array(z.string().uuid()).max(20).optional()
});

export type ChatRequestControls = z.infer<typeof chatRequestControlsSchema>;

export type StreamEvent =
  | { type: "message_start"; responseId: string; messageId?: string }
  | { type: "text_delta"; text: string }
  | { type: "message_end"; finishReason: string; usage?: NormalizedUsage; messageId?: string }
  | { type: "error"; error: NormalizedProviderError };

/** First SSE event of a chat response, naming the persisted tree nodes. */
export type ConversationStreamEvent = {
  type: "conversation";
  conversationId: string;
  runId: string;
  userMessageId: string;
  assistantMessageId: string;
  parentMessageId: string | null;
};

/** Terminal SSE event emitted after the assistant message is persisted. */
export type ConversationUpdatedStreamEvent = {
  type: "conversation_updated";
  conversationId: string;
  activeLeafMessageId: string | null;
  assistantMessageId: string | null;
};

export type ChatStreamEvent = StreamEvent | ConversationStreamEvent | ConversationUpdatedStreamEvent;

export * from "./chat-tree";
export * from "./share";

export type NormalizedUsage = {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  searchQueries?: number;
};

export type NormalizedProviderError = {
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
};
