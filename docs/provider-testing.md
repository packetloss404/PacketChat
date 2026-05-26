# Provider Testing

Use `scripts/provider-health.mjs` to test live provider connectivity without storing credentials in the repository. The script skips providers whose required environment variables are absent, but fails if every provider is skipped. Pass `--allow-empty` only for a local dry run where checking no providers is intentional.

V1 runtime provider testing covers the five provider IDs accepted by the backend contract: `openai-compatible`, `azure-openai`, `anthropic`, `perplexity`, and `minimax`. Google/Gemini is not wired as a V1 runtime provider; UI labels for Google are custom-model/forward-looking metadata and are not accepted by provider account APIs.

```shell
node scripts/provider-health.mjs
# local dry run with no credentials:
node scripts/provider-health.mjs --allow-empty
```

## Environment Variables

Set only the providers you want to test.

| Provider | Required | Optional |
| --- | --- | --- |
| OpenAI-compatible | `OPENAI_COMPATIBLE_API_KEY` | `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_MODEL` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_DEPLOYMENT` | `AZURE_OPENAI_API_VERSION` |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` |
| Perplexity | `PERPLEXITY_API_KEY` | `PERPLEXITY_BASE_URL`, `PERPLEXITY_MODEL` |
| MiniMax | `MINIMAX_API_KEY` | `MINIMAX_BASE_URL`, `MINIMAX_MODEL` |

## What It Checks

- Provider model/deployment listing where the provider exposes a compatible endpoint.
- A tiny streamed chat request with `max_tokens: 8`.
- Whether provider-reported stream usage was received.
- Graceful skip behavior when individual keys are not set, plus a non-zero exit when no provider was checked.

This script is credential-only coverage. It does not create PacketChat provider accounts, write credentials to the database, or prove that a deployment's admin/BYOK policy is configured correctly. Use `docs/smoke-test.md` for the app-level provider checklist.

## Cost And Usage Notes

- The app records provider-reported input/output/reasoning/search usage when stream end events expose it.
- If a provider omits usage, PacketChat estimates text tokens locally and marks the usage record as estimated or partially estimated.
- Cost is an estimate from the local pricing table in `apps/web/src/lib/usage.ts`; unknown pricing is recorded explicitly instead of implying a zero-cost request.
- Never commit real API keys. Use shell environment variables, a local untracked `.env`, or your deployment secret store.

## Model Governance Notes

- `/providers` shows global and user BYOK accounts, enabled/disabled route state, default route state, synced model bindings, pricing coverage, and available capability metadata.
- Disabled provider accounts are excluded from runtime routing, model sync, and connection tests until re-enabled.
- `GET /api/providers` returns enabled model bindings by default; `?includeDisabledModelBindings=true` includes disabled bindings for governance views.
- `/admin/operations` summarizes provider account status, model binding status, and recent provider audit events for release checks.
