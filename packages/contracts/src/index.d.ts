import { z } from "zod";
export declare const providerIdSchema: z.ZodEnum<["openai-compatible", "azure-openai", "anthropic", "perplexity", "minimax"]>;
export type ProviderId = z.infer<typeof providerIdSchema>;
export declare const contentPartSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "text";
    text: string;
}, {
    type: "text";
    text: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"image_url">;
    url: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "image_url";
    url: string;
}, {
    type: "image_url";
    url: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"file_ref">;
    fileId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "file_ref";
    fileId: string;
}, {
    type: "file_ref";
    fileId: string;
}>]>;
export type ContentPart = z.infer<typeof contentPartSchema>;
export declare const normalizedMessageSchema: z.ZodObject<{
    role: z.ZodEnum<["system", "developer", "user", "assistant", "tool"]>;
    content: z.ZodArray<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "text";
        text: string;
    }, {
        type: "text";
        text: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"image_url">;
        url: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "image_url";
        url: string;
    }, {
        type: "image_url";
        url: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"file_ref">;
        fileId: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "file_ref";
        fileId: string;
    }, {
        type: "file_ref";
        fileId: string;
    }>]>, "many">;
    toolCallId: z.ZodOptional<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    role: "system" | "developer" | "user" | "assistant" | "tool";
    content: ({
        type: "text";
        text: string;
    } | {
        type: "image_url";
        url: string;
    } | {
        type: "file_ref";
        fileId: string;
    })[];
    toolCallId?: string | undefined;
    name?: string | undefined;
}, {
    role: "system" | "developer" | "user" | "assistant" | "tool";
    content: ({
        type: "text";
        text: string;
    } | {
        type: "image_url";
        url: string;
    } | {
        type: "file_ref";
        fileId: string;
    })[];
    toolCallId?: string | undefined;
    name?: string | undefined;
}>;
export type NormalizedMessage = z.infer<typeof normalizedMessageSchema>;
export declare const normalizedChatRequestSchema: z.ZodObject<{
    provider: z.ZodEnum<["openai-compatible", "azure-openai", "anthropic", "perplexity", "minimax"]>;
    model: z.ZodString;
    messages: z.ZodArray<z.ZodObject<{
        role: z.ZodEnum<["system", "developer", "user", "assistant", "tool"]>;
        content: z.ZodArray<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
            type: z.ZodLiteral<"text">;
            text: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "text";
            text: string;
        }, {
            type: "text";
            text: string;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"image_url">;
            url: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "image_url";
            url: string;
        }, {
            type: "image_url";
            url: string;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"file_ref">;
            fileId: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "file_ref";
            fileId: string;
        }, {
            type: "file_ref";
            fileId: string;
        }>]>, "many">;
        toolCallId: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        role: "system" | "developer" | "user" | "assistant" | "tool";
        content: ({
            type: "text";
            text: string;
        } | {
            type: "image_url";
            url: string;
        } | {
            type: "file_ref";
            fileId: string;
        })[];
        toolCallId?: string | undefined;
        name?: string | undefined;
    }, {
        role: "system" | "developer" | "user" | "assistant" | "tool";
        content: ({
            type: "text";
            text: string;
        } | {
            type: "image_url";
            url: string;
        } | {
            type: "file_ref";
            fileId: string;
        })[];
        toolCallId?: string | undefined;
        name?: string | undefined;
    }>, "many">;
    stream: z.ZodDefault<z.ZodBoolean>;
    temperature: z.ZodOptional<z.ZodNumber>;
    maxOutputTokens: z.ZodOptional<z.ZodNumber>;
    providerHints: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    provider: "openai-compatible" | "azure-openai" | "anthropic" | "perplexity" | "minimax";
    model: string;
    messages: {
        role: "system" | "developer" | "user" | "assistant" | "tool";
        content: ({
            type: "text";
            text: string;
        } | {
            type: "image_url";
            url: string;
        } | {
            type: "file_ref";
            fileId: string;
        })[];
        toolCallId?: string | undefined;
        name?: string | undefined;
    }[];
    stream: boolean;
    temperature?: number | undefined;
    maxOutputTokens?: number | undefined;
    providerHints?: Record<string, unknown> | undefined;
}, {
    provider: "openai-compatible" | "azure-openai" | "anthropic" | "perplexity" | "minimax";
    model: string;
    messages: {
        role: "system" | "developer" | "user" | "assistant" | "tool";
        content: ({
            type: "text";
            text: string;
        } | {
            type: "image_url";
            url: string;
        } | {
            type: "file_ref";
            fileId: string;
        })[];
        toolCallId?: string | undefined;
        name?: string | undefined;
    }[];
    stream?: boolean | undefined;
    temperature?: number | undefined;
    maxOutputTokens?: number | undefined;
    providerHints?: Record<string, unknown> | undefined;
}>;
export type NormalizedChatRequest = z.infer<typeof normalizedChatRequestSchema>;
export type StreamEvent = {
    type: "message_start";
    responseId: string;
} | {
    type: "text_delta";
    text: string;
} | {
    type: "tool_call_start";
    id: string;
    name: string;
} | {
    type: "tool_call_delta";
    id: string;
    argumentsDelta: string;
} | {
    type: "tool_call_end";
    id: string;
} | {
    type: "citation";
    citation: {
        title?: string;
        url?: string;
        text?: string;
    };
} | {
    type: "message_end";
    finishReason: string;
    usage?: NormalizedUsage;
} | {
    type: "error";
    error: NormalizedProviderError;
};
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
//# sourceMappingURL=index.d.ts.map