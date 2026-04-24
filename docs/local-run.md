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
- Admin users: `http://localhost:3000/admin/users`

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

Optional break-glass admin creation can be included during bootstrap:

```shell
curl -i -X POST http://localhost:3000/api/admin/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"bootstrapToken":"replace-with-a-long-random-bootstrap-token","email":"admin@example.com","displayName":"Admin","password":"replace-with-admin-password","breakGlassEmail":"breakglass@example.com","breakGlassPassword":"replace-with-break-glass-password"}'
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

Admins can add global provider accounts. Users can add user-scoped provider accounts only when BYOK is enabled for that user.

Supported provider IDs are:

- `openai-compatible`
- `azure-openai`
- `anthropic`
- `perplexity`
- `minimax`

Add a global OpenAI-compatible provider key:

```shell
curl -i -X POST http://localhost:3000/api/providers \
  -H "Authorization: Bearer ACCESS_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"provider":"openai-compatible","scope":"global","displayName":"OpenAI Compatible","apiKey":"PROVIDER_API_KEY_HERE","baseUrl":"https://api.openai.com/v1","isDefault":true}'
```

Add an Azure OpenAI provider key:

```shell
curl -i -X POST http://localhost:3000/api/providers \
  -H "Authorization: Bearer ACCESS_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"provider":"azure-openai","scope":"global","displayName":"Azure OpenAI","apiKey":"AZURE_OPENAI_API_KEY_HERE","baseUrl":"https://RESOURCE_NAME.openai.azure.com","apiVersion":"2024-10-21","region":"eastus","isDefault":false}'
```

List visible provider accounts:

```shell
curl -i http://localhost:3000/api/providers \
  -H "Authorization: Bearer ACCESS_TOKEN_HERE"
```

Test a provider account:

```shell
curl -i -X POST http://localhost:3000/api/providers/openai-compatible/test \
  -H "Authorization: Bearer ACCESS_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"providerAccountId":"PROVIDER_ACCOUNT_ID_HERE"}'
```

## Toggle BYOK

An admin can enable or disable BYOK per non-break-glass user.

Create a test user with BYOK enabled:

```shell
curl -i -X POST http://localhost:3000/api/admin/users \
  -H "Authorization: Bearer ADMIN_ACCESS_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","displayName":"Test User","role":"user","password":"replace-with-user-password","byokEnabled":true}'
```

Toggle BYOK for an existing user:

```shell
curl -i -X PATCH http://localhost:3000/api/admin/users/USER_ID_HERE/byok \
  -H "Authorization: Bearer ADMIN_ACCESS_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"byokEnabled":true}'
```

Disable BYOK by sending `{"byokEnabled":false}` to the same endpoint. When BYOK is disabled, a user-scoped provider create request returns `403`.

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

```shell
PACKETCHAT_SMOKE_EMAIL=admin@example.com PACKETCHAT_SMOKE_PASSWORD=replace-with-admin-password npm run smoke
```

Run local code verification before opening a pull request:

```shell
npm run typecheck
npm run build
npm run smoke
```

When credentials are available, prefer the authenticated smoke command above because it exercises no-key CRUD, archive/delete, and knowledge text upload/search paths without requiring provider API keys or Resend.

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

## Post-Agent-Builder Work

The `/agents` page supports creating agents, editing drafts, and publishing immutable versions. Agent run execution, evaluations, schedules, and production run observability are still future work and should be validated separately when implemented.

## Stop The Stack

Stop containers without deleting named volumes:

```shell
npm run compose:down
```

This is non-destructive for local data because the Compose named volumes remain. Do not add `--volumes` unless you intentionally want to delete local Postgres, Redis, and MinIO data.
