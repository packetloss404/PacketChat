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
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image_url"), url: z.string().url() }),
  z.object({ type: z.literal("file_ref"), fileId: z.string().uuid() })
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

export type StreamEvent =
  | { type: "message_start"; responseId: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; argumentsDelta: string }
  | { type: "tool_call_end"; id: string }
  | { type: "citation"; citation: { title?: string; url?: string; text?: string } }
  | { type: "message_end"; finishReason: string; usage?: NormalizedUsage }
  | { type: "error"; error: NormalizedProviderError };

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
