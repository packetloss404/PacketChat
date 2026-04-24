import type { NormalizedChatRequest, NormalizedMessage, NormalizedUsage, ProviderId } from "@packetchat/contracts";
import { getSql } from "@packetchat/db";

type Price = {
  inputPerMillion: number;
  outputPerMillion: number;
  reasoningPerMillion?: number;
  searchPerQuery?: number;
};

type UsageRecordInput = {
  ownerUserId: string;
  providerAccountId: string;
  conversationRunId?: string | null;
  agentRunId?: string | null;
  provider: ProviderId;
  model: string;
  request: NormalizedChatRequest;
  outputText: string;
  providerUsage?: NormalizedUsage | null;
};

export type UsagePricingStatus = {
  known: boolean;
  source: "catalog" | "fallback" | "unknown";
  matchedModelIncludes?: string;
  rates?: Price;
};

const prices: Array<{ provider: ProviderId | "any"; modelIncludes: string; price: Price }> = [
  { provider: "openai-compatible", modelIncludes: "gpt-4o-mini", price: { inputPerMillion: 0.15, outputPerMillion: 0.6 } },
  { provider: "openai-compatible", modelIncludes: "gpt-4o", price: { inputPerMillion: 2.5, outputPerMillion: 10 } },
  { provider: "openai-compatible", modelIncludes: "gpt-4.1-mini", price: { inputPerMillion: 0.4, outputPerMillion: 1.6 } },
  { provider: "openai-compatible", modelIncludes: "gpt-4.1", price: { inputPerMillion: 2, outputPerMillion: 8 } },
  { provider: "openai-compatible", modelIncludes: "o3-mini", price: { inputPerMillion: 1.1, outputPerMillion: 4.4 } },
  { provider: "azure-openai", modelIncludes: "gpt-4o-mini", price: { inputPerMillion: 0.15, outputPerMillion: 0.6 } },
  { provider: "azure-openai", modelIncludes: "gpt-4o", price: { inputPerMillion: 2.5, outputPerMillion: 10 } },
  { provider: "azure-openai", modelIncludes: "gpt-4.1-mini", price: { inputPerMillion: 0.4, outputPerMillion: 1.6 } },
  { provider: "azure-openai", modelIncludes: "gpt-4.1", price: { inputPerMillion: 2, outputPerMillion: 8 } },
  { provider: "anthropic", modelIncludes: "claude-3-5-haiku", price: { inputPerMillion: 0.8, outputPerMillion: 4 } },
  { provider: "anthropic", modelIncludes: "claude-3-5-sonnet", price: { inputPerMillion: 3, outputPerMillion: 15 } },
  { provider: "anthropic", modelIncludes: "claude-3-7-sonnet", price: { inputPerMillion: 3, outputPerMillion: 15 } },
  { provider: "perplexity", modelIncludes: "sonar", price: { inputPerMillion: 1, outputPerMillion: 1, searchPerQuery: 0.005 } },
  { provider: "minimax", modelIncludes: "abab", price: { inputPerMillion: 0.2, outputPerMillion: 1.1 } },
  { provider: "any", modelIncludes: "gpt-4o-mini", price: { inputPerMillion: 0.15, outputPerMillion: 0.6 } },
  { provider: "any", modelIncludes: "gpt-4o", price: { inputPerMillion: 2.5, outputPerMillion: 10 } },
  { provider: "any", modelIncludes: "claude", price: { inputPerMillion: 3, outputPerMillion: 15 } }
];

function textFromMessage(message: NormalizedMessage) {
  return message.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function priceFor(provider: ProviderId, model: string) {
  const normalizedModel = model.toLowerCase();
  return prices.find((entry) => entry.provider === provider && normalizedModel.includes(entry.modelIncludes))
    ?? prices.find((entry) => entry.provider === "any" && normalizedModel.includes(entry.modelIncludes))
    ?? null;
}

export function getUsagePricingStatus(provider: ProviderId | null | undefined, model: string): UsagePricingStatus {
  if (!provider) return { known: false, source: "unknown" };
  const matchedPrice = priceFor(provider, model);
  if (!matchedPrice) return { known: false, source: "unknown" };
  return {
    known: true,
    source: matchedPrice.provider === provider ? "catalog" : "fallback",
    matchedModelIncludes: matchedPrice.modelIncludes,
    rates: matchedPrice.price
  };
}

function hasProviderUsageValue(providerUsage: NormalizedUsage | null, key: keyof NormalizedUsage) {
  return typeof providerUsage?.[key] === "number";
}

export async function recordUsage(input: UsageRecordInput) {
  const providerUsage = input.providerUsage ?? null;
  const inputTokens = providerUsage?.inputTokens ?? estimateTokens(input.request.messages.map(textFromMessage).join("\n\n"));
  const outputTokens = providerUsage?.outputTokens ?? estimateTokens(input.outputText);
  const reasoningTokens = providerUsage?.reasoningTokens ?? 0;
  const searchQueries = providerUsage?.searchQueries ?? (input.provider === "perplexity" ? 1 : 0);
  const matchedPrice = priceFor(input.provider, input.model);
  const tokenSources = {
    inputTokens: hasProviderUsageValue(providerUsage, "inputTokens") ? "provider" : "estimated",
    outputTokens: hasProviderUsageValue(providerUsage, "outputTokens") ? "provider" : "estimated",
    reasoningTokens: hasProviderUsageValue(providerUsage, "reasoningTokens") ? "provider" : "default_zero",
    searchQueries: hasProviderUsageValue(providerUsage, "searchQueries") ? "provider" : input.provider === "perplexity" ? "provider_default" : "default_zero"
  };
  const estimated = Object.values(tokenSources).some((source) => source === "estimated" || source === "provider_default");
  const costUsd = matchedPrice
    ? (inputTokens * matchedPrice.price.inputPerMillion
      + outputTokens * matchedPrice.price.outputPerMillion
      + reasoningTokens * (matchedPrice.price.reasoningPerMillion ?? matchedPrice.price.outputPerMillion)) / 1_000_000
      + searchQueries * (matchedPrice.price.searchPerQuery ?? 0)
    : null;

  const sql = getSql();
  await sql`
    insert into usage_records (
      owner_user_id,
      provider_account_id,
      conversation_run_id,
      agent_run_id,
      provider,
      model,
      input_tokens,
      output_tokens,
      reasoning_tokens,
      search_queries,
      cost_usd,
      raw_usage
    ) values (
      ${input.ownerUserId},
      ${input.providerAccountId},
      ${input.conversationRunId ?? null},
      ${input.agentRunId ?? null},
      ${input.provider},
      ${input.model},
      ${inputTokens},
      ${outputTokens},
      ${reasoningTokens},
      ${searchQueries},
      ${costUsd},
      ${JSON.stringify({
        estimated,
        usageSource: providerUsage ? (estimated ? "provider_partial" : "provider") : "estimated",
        tokenSources,
        costEstimate: matchedPrice
          ? { knownPricing: true, estimatedTokens: estimated, currency: "USD", amount: costUsd }
          : { knownPricing: false, estimatedTokens: estimated, currency: "USD", amount: null },
        providerUsage,
        pricing: matchedPrice
          ? { provider: matchedPrice.provider, modelIncludes: matchedPrice.modelIncludes, ...matchedPrice.price }
          : { provider: input.provider, model: input.model, unknown: true }
      })}::jsonb
    )
  `;
}
