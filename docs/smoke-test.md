# Smoke-Test Checklist

Run this checklist after a local start, release deployment, restore drill, or operator change.

## Preflight

- `.env` exists and has non-default `BOOTSTRAP_TOKEN`, `JWT_SECRET`, and `ENCRYPTION_KEY_BASE64` for any shared environment.
- `APP_BASE_URL` matches the URL being tested.
- `npm run compose:check` passes for Docker/Compose or dependency changes. This renders the Compose config and builds the `web`, `worker`, and `migrate` image targets without starting containers.
- `npm run compose:up` completed without container restart loops.
- `npm run compose:migrate` completed exactly once for the current release.
- `docker compose --env-file .env -f infrastructure/compose/docker-compose.yml ps` shows expected services running or healthy.

## Health

CI runs the static production gate plus `npm run compose:check`. It intentionally does not run this live smoke script because readiness depends on a started stack, applied migrations, object storage buckets, and optional deployment credentials.

- Run the lightweight API smoke script:

```shell
npm run smoke
```

- Without credentials, the script verifies `GET /api/healthz`, `GET /api/readyz`, and anonymous `401` responses for protected API routes.
- To include login and authenticated no-provider-key integration checks, set `PACKETCHAT_SMOKE_EMAIL` and `PACKETCHAT_SMOKE_PASSWORD` before running `npm run smoke`. For release gates, also set `PACKETCHAT_SMOKE_REQUIRE_AUTH=1` so missing credentials or unfinished ingestion fail the run.

PowerShell:

```powershell
$env:PACKETCHAT_SMOKE_EMAIL = "admin@example.com"
$env:PACKETCHAT_SMOKE_PASSWORD = "replace-with-admin-password"
$env:PACKETCHAT_SMOKE_REQUIRE_AUTH = "1"
npm run smoke
```

POSIX shells:

```shell
PACKETCHAT_SMOKE_EMAIL=admin@example.com PACKETCHAT_SMOKE_PASSWORD=replace-with-admin-password PACKETCHAT_SMOKE_REQUIRE_AUTH=1 npm run smoke
```

For non-local targets, also set `PACKETCHAT_BASE_URL` to the deployment URL. The smoke script does not read `.env` by itself; the variables must be present in the environment of the `npm run smoke` process.

- `GET /api/healthz` returns `200` and `{"ok":true}`.
- `GET /api/readyz` returns `200` with `database`, `redis`, and `objectStorage` set to `ok`.
- `web` logs do not show repeated startup, auth, database, Redis, or object storage errors.
- `worker` logs show startup without queue connection failures, including a `Cleanup schedule registered` line.

## Automated Route Coverage

`npm run smoke` currently covers these routes without provider API keys or Resend:

- Public health: `GET /api/healthz`, `GET /api/readyz`.
- Anonymous protection checks: `GET /api/auth/me`, `GET /api/projects`, `POST /api/projects`, `GET /api/prompts`, `POST /api/prompts`, `GET /api/conversations`, `POST /api/conversations`, `GET /api/knowledge`, `POST /api/knowledge`, `POST /api/knowledge/{knowledgeBaseId}/search`, `GET /api/providers`, `POST /api/chat`.
- With `PACKETCHAT_SMOKE_EMAIL` and `PACKETCHAT_SMOKE_PASSWORD`: `POST /api/auth/login`, `GET /api/auth/me`, project create/update/delete, prompt create/update/delete, conversation create/list/message list/rename/archive/delete, agent create/list/update/archive/delete, knowledge base create/list/update/archive/delete, text document upload/rename/delete, and knowledge search.

The authenticated smoke path creates timestamped test records and deletes them before exit. Knowledge text upload waits briefly for worker ingestion; if the document is still queued, the script reports that search validation was skipped for local non-strict runs. With `PACKETCHAT_SMOKE_REQUIRE_AUTH=1`, unfinished ingestion fails the smoke run.

## Manual Release Readiness

After authenticated smoke passes, use `docs/release-readiness.md` for the concise P0/P1 surface check. At minimum, open `/projects`, `/knowledge`, `/providers`, `/agents`, `/approvals`, `/admin/usage`, `/admin/audit`, `/admin/operations`, and `/admin/approvals` as an authorized user and confirm each page loads current data without console, auth, or server errors.

## Auth And Admin

- Open `http://localhost:3000` or the deployed base URL.
- Bootstrap the first admin if this is a fresh database.
- Login with the admin account.
- `GET /api/auth/me` succeeds with the returned bearer token.
- Create a test user from the admin users flow or `POST /api/admin/users`.

## Providers

- Add at least one app-wide provider account as admin from `/admin/providers`.
- `GET /api/providers` lists the new provider account.
- `GET /api/providers` includes `usagePricing` on model bindings so operators can see whether local cost estimates are matched, fallback, or unknown.
- The `/admin/providers` page shows enabled/disabled provider routes, default route state, synced model binding counts, pricing coverage, and capability metadata.
- A non-admin user opening `/admin/providers` sees the admin-access notice instead of the provider form, and `POST /api/providers` returns `403` for that user.
- A non-admin user sees every enabled provider account in `/providers` and in the chat model picker without any per-user setup.
- `POST /api/providers/{providerId}/test` succeeds or returns a sanitized provider failure. Admin access is required.
- To test live provider keys without storing credentials, run `node scripts/provider-health.mjs`. See `docs/provider-testing.md` for all five provider environment variables. The script fails if every provider is skipped unless you pass `--allow-empty`.
- V1 provider IDs are `openai-compatible`, `azure-openai`, `anthropic`, `perplexity`, and `minimax`; `google` is not accepted by the backend provider APIs.

## Credential-Only Tests

These checks still require external credentials, provider configuration, or email delivery and are intentionally not part of the default smoke script:

- Admin bootstrap, and invite/password-reset email delivery through SMTP or Resend. With the default `EMAIL_PROVIDER=manual` nothing is sent and the link comes back in the response, which is what the automated checks exercise.
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
- Creating a provider account or running a model sync from `/admin/providers` enqueues a `sync-provider` job; `worker` logs `Provider sync job completed` and no new job failure appears.
- Worker logs remain clean during provider sync or queued work.
- Starting an agent run with `{"async": true}` returns `202` with a run id; `worker` logs `Agent run job received` and then `Agent run job completed`, and `GET /api/agents/{agentId}/runs/{runId}` reaches a terminal status. A run still `queued` after the worker has been idle means the queue is not being consumed - it is marked `timed_out` once it is 20 minutes old.
- `/admin/operations` shows provider account status, model binding status, knowledge ingestion status, seven-day agent run status, and recent job failures.

## Shutdown

- `npm run compose:down` stops the stack cleanly.
- A subsequent `npm run compose:up` reuses existing volumes and `GET /api/readyz` returns `200` after startup.
- Do not use volume deletion during smoke tests unless the test explicitly requires a fresh data wipe.
