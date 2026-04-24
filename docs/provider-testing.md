# Provider Testing

Use `scripts/provider-health.mjs` to test live provider connectivity without storing credentials in the repository. The script skips any provider whose required environment variables are absent.

```shell
node scripts/provider-health.mjs
```

## Environment Variables

Set only the providers you want to test.

| Provider | Required | Optional |
| --- | --- | --- |
| OpenAI-compatible | `OPENAI_COMPATIBLE_API_KEY` | `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_MODEL` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_DEPLOYMENT` | `AZURE_OPENAI_API_VERSION` |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` |
| Perplexity | `PERPLEXITY_API_KEY` | `PERPLEXITY_BASE_URL`, `PERPLEXITY_MODEL` |
| Minimax | `MINIMAX_API_KEY` | `MINIMAX_BASE_URL`, `MINIMAX_MODEL` |

## What It Checks

- Provider model/deployment listing where the provider exposes a compatible endpoint.
- A tiny streamed chat request with `max_tokens: 8`.
- Whether provider-reported stream usage was received.
- Graceful skip behavior when keys are not set.

## Cost And Usage Notes

- The app records provider-reported input/output/reasoning/search usage when stream end events expose it.
- If a provider omits usage, PacketChat estimates text tokens locally and marks the usage record as estimated or partially estimated.
- Cost is an estimate from the local pricing table in `apps/web/src/lib/usage.ts`; unknown pricing is recorded explicitly instead of implying a zero-cost request.
- Never commit real API keys. Use shell environment variables, a local untracked `.env`, or your deployment secret store.
