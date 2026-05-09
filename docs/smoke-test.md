# Smoke-Test Checklist

Run this checklist after a local start, release deployment, restore drill, or operator change.

## Preflight

- `.env` exists and has non-default `BOOTSTRAP_TOKEN`, `JWT_SECRET`, and `ENCRYPTION_KEY_BASE64` for any shared environment.
- `APP_BASE_URL` matches the URL being tested.
- `npm run compose:up` completed without container restart loops.
- `npm run compose:migrate` completed exactly once for the current release.
- `docker compose --env-file .env -f infrastructure/compose/docker-compose.yml ps` shows expected services running or healthy.

## Health

- Run the lightweight API smoke script:

```shell
npm run smoke
```

- Without credentials, the script verifies `GET /api/healthz`, `GET /api/readyz`, and anonymous `401` responses for protected API routes.
- To include login and authenticated no-provider-key integration checks, set `PACKETCHAT_SMOKE_EMAIL` and `PACKETCHAT_SMOKE_PASSWORD` before running `npm run smoke`.

PowerShell:

```powershell
$env:PACKETCHAT_SMOKE_EMAIL = "admin@example.com"
$env:PACKETCHAT_SMOKE_PASSWORD = "replace-with-admin-password"
npm run smoke
```

POSIX shells:

```shell
PACKETCHAT_SMOKE_EMAIL=admin@example.com PACKETCHAT_SMOKE_PASSWORD=replace-with-admin-password npm run smoke
```

For non-local targets, also set `PACKETCHAT_BASE_URL` to the deployment URL. The smoke script does not read `.env` by itself; the variables must be present in the environment of the `npm run smoke` process.

- `GET /api/healthz` returns `200` and `{"ok":true}`.
- `GET /api/readyz` returns `200` with `database`, `redis`, and `objectStorage` set to `ok`.
- `web` logs do not show repeated startup, auth, database, Redis, or object storage errors.
- `worker` logs show startup without queue connection failures.

## Automated Route Coverage

`npm run smoke` currently covers these routes without provider API keys or Resend:

- Public health: `GET /api/healthz`, `GET /api/readyz`.
- Anonymous protection checks: `GET /api/auth/me`, `GET /api/projects`, `POST /api/projects`, `GET /api/prompts`, `POST /api/prompts`, `GET /api/conversations`, `POST /api/conversations`, `GET /api/knowledge`, `POST /api/knowledge`, `POST /api/knowledge/{knowledgeBaseId}/search`, `GET /api/providers`, `POST /api/chat`.
- With `PACKETCHAT_SMOKE_EMAIL` and `PACKETCHAT_SMOKE_PASSWORD`: `POST /api/auth/login`, `GET /api/auth/me`, project create/update/delete, prompt create/update/delete, conversation create/list/message list/rename/archive/delete, agent create/list/update/archive/delete, knowledge base create/list/update/archive/delete, text document upload/rename/delete, and knowledge search.

The authenticated smoke path creates timestamped test records and deletes them before exit. Knowledge text upload waits briefly for worker ingestion; if the document is still queued, the script reports that search validation was skipped and continues to verify document cleanup.

## Auth And Admin

- Open `http://localhost:3000` or the deployed base URL.
- Bootstrap the first admin if this is a fresh database.
- Login with the admin account.
- `GET /api/auth/me` succeeds with the returned bearer token.
- Create a test user from the admin users flow or `POST /api/admin/users`.
- Toggle BYOK on for the test user and verify the API response includes `byokEnabled: true`.
- Toggle BYOK off again if the user should not retain personal provider keys.

## Providers

- Add at least one global provider account as admin.
- `GET /api/providers` lists the new provider account.
- `GET /api/providers` includes `usagePricing` on model bindings so operators can see whether local cost estimates are matched, fallback, or unknown.
- `POST /api/providers/{providerId}/test` succeeds or returns a provider-specific failure that matches the supplied test key and endpoint.
- With BYOK enabled, a regular user can add a `scope: "user"` provider account.
- With BYOK disabled, the same user receives `403` when adding a `scope: "user"` provider account.
- To test live provider keys without storing credentials, run `node scripts/provider-health.mjs`. See `docs/provider-testing.md` for all five provider environment variables.
- V1 provider IDs are `openai-compatible`, `azure-openai`, `anthropic`, `perplexity`, and `minimax`; `google` is not accepted by the backend provider APIs.

## Credential-Only Tests

These checks still require external credentials, provider configuration, or email delivery and are intentionally not part of the default smoke script:

- Admin bootstrap and invite/password-reset email delivery through Resend.
- Provider account creation with real provider credentials.
- `POST /api/providers/{providerId}/test` against a live provider endpoint.
- `POST /api/providers/{providerId}/models` when the provider requires live credentials.
- `POST /api/chat` success path with provider-generated output.
- Large file upload and long-running knowledge ingestion beyond the lightweight text upload covered by authenticated smoke.
- Manual agent runs that depend on model/provider availability.

## Chat Path

- Start a chat using a configured provider account.
- The `/api/chat` response streams server-sent events with `text/event-stream` content type.
- A simple prompt returns either provider text or a clear provider error event.
- Chat errors do not crash or restart `web` or `worker`.

## Storage And Background Work

- MinIO readiness remains `ok` after uploads or provider tests that touch object storage.
- Redis readiness remains `ok` after login and chat activity.
- Worker logs remain clean during provider sync or queued work.

## Shutdown

- `npm run compose:down` stops the stack cleanly.
- A subsequent `npm run compose:up` reuses existing volumes and `GET /api/readyz` returns `200` after startup.
- Do not use volume deletion during smoke tests unless the test explicitly requires a fresh data wipe.
