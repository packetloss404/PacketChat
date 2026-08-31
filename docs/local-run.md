# Local Run Guide

This guide runs the full PacketChat stack locally with Docker Compose.

## Current Local URLs

- Web app and API: `http://localhost:3000`
- Liveness: `http://localhost:3000/api/healthz`
- Readiness: `http://localhost:3000/api/readyz`
- Login: `http://localhost:3000/login`
- Chat: `http://localhost:3000/chat`
- Providers: `http://localhost:3000/providers`
- Projects: `http://localhost:3000/projects`
- Prompts: `http://localhost:3000/prompts`
- Knowledge: `http://localhost:3000/knowledge`
- Agents: `http://localhost:3000/agents`
- Approvals: `http://localhost:3000/approvals`
- Admin users: `http://localhost:3000/admin/users`
- Admin usage: `http://localhost:3000/admin/usage`
- Admin audit: `http://localhost:3000/admin/audit`
- Admin operations: `http://localhost:3000/admin/operations`
- Admin approvals shortcut: `http://localhost:3000/admin/approvals`

If `PACKETCHAT_WEB_PORT` is set in `.env`, replace `3000` with that port.

## Prerequisites

- Node.js `>=22`
- npm `>=10`
- Docker with Compose v2

## Configure Environment

1. Create `.env` from the example:

```powershell
Copy-Item .env.example .env
```

2. Replace these values before running a shared or persistent instance:

```dotenv
BOOTSTRAP_TOKEN=replace-with-a-long-random-bootstrap-token
JWT_SECRET=replace-with-a-long-random-jwt-secret
ENCRYPTION_KEY_BASE64=replace-with-a-32-byte-base64-key
APP_BASE_URL=http://localhost:3000
COOKIE_SECURE=false
```

For local-only testing, `APP_BASE_URL=http://localhost:3000` and `COOKIE_SECURE=false` are expected.

## Start The Stack

Install dependencies once:

```shell
npm install
```

Build and start the Compose stack:

```shell
npm run compose:up
```

This starts `web`, `worker`, `postgres`, `redis`, `minio`, and the MinIO bucket initializer. The `web` service is published at `http://localhost:3000` by default.

The `worker` service runs file ingestion, provider-sync model discovery, and a daily retention cleanup it schedules itself. See `docs/runbooks/worker-queues.md` for retention windows and the manual cleanup trigger.

## Run Migrations

Run migrations after the stack is up and Postgres is healthy:

```shell
npm run compose:migrate
```

For releases, run the migration job once per release. Do not run migrations concurrently from multiple shells or services.

## Bootstrap Admin

You can bootstrap from the UI at `http://localhost:3000`, or call the API directly. Use the same `BOOTSTRAP_TOKEN` value from `.env`.

```shell
curl -i -X POST http://localhost:3000/api/admin/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"bootstrapToken":"replace-with-a-long-random-bootstrap-token","email":"admin@example.com","displayName":"Admin","password":"replace-with-admin-password"}'
```

Bootstrap can only complete while the users table is empty. A second bootstrap attempt returns `409`.

## Seed Demo Data

After bootstrapping an admin, populate the local workspace for UI review without provider API keys or Resend:

```shell
npm run seed:demo
```

The script creates non-destructive `Demo:` projects, prompts, conversations, knowledge data, and an active agent for the first active admin. Set `PACKETCHAT_DEMO_ADMIN_EMAIL=admin@example.com` to target a specific admin. See `docs/demo-seed.md` for details.

## Login API

Login returns an access token in the JSON response and sets a refresh cookie.

```shell
curl -i -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"replace-with-admin-password"}'
```

Use the returned `accessToken` in authenticated API calls:

```shell
curl -i http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer ACCESS_TOKEN_HERE"
```

## Add Provider Keys

Only admins can add provider accounts, and every account is app-wide. Manage them at `/admin/providers`.

Supported provider IDs are:

- `openai-compatible`
- `azure-openai`
- `anthropic`
- `perplexity`
- `minimax`

Google/Gemini is not accepted by the V1 backend provider contract. If Google appears in the Models UI, treat it as custom-model/forward-looking metadata, not as a runtime provider account type.

Add an app-wide OpenAI-compatible provider key (admin token required):

```shell
curl -i -X POST http://localhost:3000/api/providers \
  -H "Authorization: Bearer ACCESS_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"provider":"openai-compatible","displayName":"OpenAI Compatible","apiKey":"PROVIDER_API_KEY_HERE","baseUrl":"https://api.openai.com","isDefault":true}'
```

Add an app-wide Azure OpenAI provider key (admin token required):

```shell
curl -i -X POST http://localhost:3000/api/providers \
  -H "Authorization: Bearer ACCESS_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"provider":"azure-openai","displayName":"Azure OpenAI","apiKey":"AZURE_OPENAI_API_KEY_HERE","baseUrl":"https://RESOURCE_NAME.openai.azure.com","apiVersion":"2024-10-21","region":"eastus","isDefault":false}'
```

List provider accounts:

```shell
curl -i http://localhost:3000/api/providers \
  -H "Authorization: Bearer ACCESS_TOKEN_HERE"
```

Test a provider account (admin token required):

```shell
curl -i -X POST http://localhost:3000/api/providers/openai-compatible/test \
  -H "Authorization: Bearer ACCESS_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"providerAccountId":"PROVIDER_ACCOUNT_ID_HERE"}'
```

## Create A User

An admin can create a user directly with a password:

```shell
curl -i -X POST http://localhost:3000/api/admin/users \
  -H "Authorization: Bearer ADMIN_ACCESS_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","displayName":"Test User","role":"user","password":"replace-with-user-password"}'
```

Omit `password` to generate an invite URL instead. Provider keys are app-wide, so a new user
immediately sees every enabled provider account without any per-user setup.

## Health Checks

Check web liveness:

```shell
curl -i http://localhost:3000/api/healthz
```

Check dependency readiness for Postgres, Redis, and object storage:

```shell
curl -i http://localhost:3000/api/readyz
```

Run the smoke script against `APP_BASE_URL` or `http://localhost:3000`:

```shell
npm run smoke
```

Include a login check when credentials exist:

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

Run local code verification before opening a pull request:

```shell
npm run verify
npm run build
```

When credentials are available and the Compose stack is running, also run the authenticated smoke command above because it exercises no-key CRUD, archive/delete, and knowledge text upload/search paths without requiring provider API keys or Resend. For release handoff, pair smoke with the manual checks in `docs/release-readiness.md`.

## Mobile Use

The web UI is responsive for phone-width administration and chat workflows:

- The left navigation becomes a horizontally scrollable chip bar above the session header.
- Session actions, chat controls, provider account actions, agent controls, and knowledge cards stack into full-width tap targets.
- Wide data tables remain horizontally scrollable when their columns cannot fit.

For manual mobile checks, open `http://localhost:3000` from a device on the same network or use browser device emulation at widths around `390px`, `430px`, and `768px`. Verify `/chat`, `/providers`, `/agents`, and `/knowledge` because these pages have the densest controls.

Inspect Compose service health:

```shell
docker compose --env-file .env -f infrastructure/compose/docker-compose.yml ps
```

Follow logs:

```shell
npm run compose:logs
```

## Backups

Create local backup artifacts without deleting or changing running data:

```shell
npm run backup
```

Use `npm run backup:postgres` or `npm run backup:minio` to back up one store. See `docs/runbooks/backup-restore.md` for manual commands and restore-drill guidance.

## Release Readiness Surfaces

Use these pages after smoke tests when validating a local candidate build:

- `/projects`: verify project workspaces show persistent instructions, default-model readiness, and linked chat counts.
- `/knowledge`: run a test search and expand result debug details for matched terms, scores, source metadata, freshness, and embedding status.
- `/providers`: verify enabled routes, default route, synced model bindings, pricing coverage, and disabled-account guardrails.
- `/agents`: run a published agent, then inspect run history, trace steps/events, usage, and any approval step state.
- `/approvals` and the `/admin/approvals` shortcut: verify pending approval steps are visible and can be resolved by an authorized user.
- `/admin/usage`, `/admin/audit`, and `/admin/operations`: review cost governance, latest audit events, and provider/model/knowledge/run/job health rollups.

See `docs/release-readiness.md` for the concise operator checklist.

## Agent Run Scope

The `/agents` page supports creating single-pass augmented agents, editing drafts, publishing immutable versions, and starting manual runs for published agents when the agent spec has a valid provider account and model. Manual and chat-launched runs can use simple knowledge lookup, calculator, URL fetch, provider streaming, persisted run events, and transcript persistence when launched from chat.

Run history, trace steps/events, usage summaries, and approval checkpoints are wired for the current single-pass runtime. Scheduled runs, evaluations, and true multi-step tool loops are outside the V1 scope and should not be promised as wired behavior.

## Stop The Stack

Stop containers without deleting named volumes:

```shell
npm run compose:down
```

This is non-destructive for local data because the Compose named volumes remain. Do not add `--volumes` unless you intentionally want to delete local Postgres, Redis, and MinIO data.
