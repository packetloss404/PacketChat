import { z } from "zod";
export const providerIdSchema = z.enum([
    "openai-compatible",
    "azure-openai",
    "anthropic",
    "perplexity",
    "minimax"
]);
export const contentPartSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("image_url"), url: z.string().url() }),
    z.object({ type: z.literal("file_ref"), fileId: z.string().uuid() })
]);
export const normalizedMessageSchema = z.object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    content: z.array(contentPartSchema),
    toolCallId: z.string().optional(),
    name: z.string().optional()
});
export const normalizedChatRequestSchema = z.object({
    provider: providerIdSchema,
    model: z.string().min(1),
    messages: z.array(normalizedMessageSchema),
    stream: z.boolean().default(true),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    providerHints: z.record(z.unknown()).optional()
});
