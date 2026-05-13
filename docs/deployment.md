# Deployment

PacketChat V1 is designed for a single private deployment with an external reverse proxy.

## Services

- `web`: Next.js UI and API on port `3000`.
- `worker`: background jobs for ingestion, provider sync, agent runs, and cleanup.
- `migrate`: one-shot DB migration command.
- `postgres`: primary database.
- `redis`: queues and transient coordination.
- `minio`: S3-compatible object storage.

## External Reverse Proxy

Only expose `web` to your proxy. Keep Postgres, Redis, and MinIO private on the Docker network.

Required proxy behavior:

- forward HTTPS traffic to `web:3000`
- preserve `Host`
- set `X-Forwarded-Proto`
- set `X-Forwarded-For`
- allow long-running SSE responses for chat streams

## First Deploy

1. Copy `.env.example` to `.env`.
2. Replace `BOOTSTRAP_TOKEN`, `JWT_SECRET`, and `ENCRYPTION_KEY_BASE64`.
3. Set `APP_BASE_URL` to the public HTTPS URL served by your proxy.
4. Set `COOKIE_SECURE=true` for HTTPS deployments.
5. Leave `APP_TRUSTED_PROXY=true` only when the reverse proxy supplies trustworthy forwarded headers.
6. Start dependencies and app: `npm run compose:up`.
7. Run migrations: `npm run compose:migrate`.
8. Visit `/` and bootstrap the first admin account.

For local operator commands and API examples, see `docs/local-run.md`.

## Provider Keys

Provider accounts can be configured globally by the admin. Per-user BYOK is gated by `users.byok_enabled`, controlled from the admin users screen or `PATCH /api/admin/users/{userId}/byok`.

The V1 runtime provider contract accepts `openai-compatible`, `azure-openai`, `anthropic`, `perplexity`, and `minimax`. Google/Gemini is not wired as a runtime provider in V1; do not document or configure `google` as a provider account type.

Provider key and BYOK API examples are in `docs/local-run.md`.

## Rate Limiting

API rate limits are Redis-backed and use `REDIS_URL`. Auth endpoints use `RATE_LIMIT_AUTH_PER_MINUTE` with a fixed one-minute window. Chat, agent-run, and expensive provider endpoints use `RATE_LIMIT_CHAT_PER_MINUTE` with a sliding one-minute window. File uploads use `RATE_LIMIT_FILE_UPLOAD_PER_MINUTE` with a sliding one-minute window.

Requests over the limit return `429` with `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers plus JSON retry details. Authenticated requests are keyed by user id; anonymous requests fall back to client IP from forwarded headers.

## Smoke Testing

Run `npm run smoke` and the checklist in `docs/smoke-test.md` after first deploy, upgrades, restore drills, and operator changes. Set `PACKETCHAT_BASE_URL` for non-local targets and `PACKETCHAT_SMOKE_EMAIL` / `PACKETCHAT_SMOKE_PASSWORD` when login should be included.

## UI Routes

- `/login`: local password login.
- `/chat`: authenticated chat test surface.
- `/providers`: provider account management.
- `/projects`: project management.
- `/prompts`: prompt management.
- `/knowledge`: knowledge base and document management.
- `/agents`: single-pass augmented agent drafts, publishing, sharing, and manual/chat-launched runs.
- `/admin/users`: admin user operations.

## Backups

Before upgrades and restore drills, run `npm run backup` for the Compose stack or use the documented `pg_dump` and MinIO tar commands in `docs/runbooks/backup-restore.md`.

## V1 Production Readiness

Compose is the supported V1 deployment shape. Treat a deployment as pilot/prod-ready only after the deployment-specific checklist is complete:

- Do not use `latest` image tags for pilot/prod.
- Set non-default `BOOTSTRAP_TOKEN`, `JWT_SECRET`, and `ENCRYPTION_KEY_BASE64`.
- Serve through HTTPS with `COOKIE_SECURE=true`.
- Do not publish Postgres, Redis, or MinIO ports.
- Keep `.env` and backup artifacts out of source control.
- Verify provider keys with `POST /api/providers/{providerId}/test` or `scripts/provider-health.mjs` before relying on chat/agent runs.
- Back up Postgres and MinIO before upgrades.
- Run a restore drill before calling the deployment production-ready.
- Run the migration job exactly once per release before app rollout.
- Run `npm run smoke` after first deploy, upgrades, and restore drills. Include `PACKETCHAT_SMOKE_EMAIL` / `PACKETCHAT_SMOKE_PASSWORD` for authenticated coverage.
- Stop the Compose stack with `npm run compose:down`; do not remove volumes unless intentionally wiping local data.

Outside the V1 promise: multi-tenant workspaces/teams, SSO, high availability orchestration, external managed-service recipes, Kubernetes manifests, email-delivered invite/reset flows, scheduled agent runs, evaluations, true multi-step tool loops, and Google/Gemini runtime provider support.
