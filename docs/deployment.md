# Deployment

PacketChat V1 is designed for a single private deployment with an external reverse proxy.

## Services

- `web`: Next.js UI and API on port `3000`.
- `worker`: background jobs for file ingestion, provider-sync model discovery, and scheduled retention cleanup. The `agent-run` queue is intentionally not wired: agent runs execute synchronously in `web`, nothing enqueues an `agent-run` job, and the worker rejects any that arrives.
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

Provider accounts are app-wide. Only admins can create, edit, rotate, test, or delete them, from `/admin/providers`. Every enabled account is available to every user; there is no per-user provider scope.

The V1 runtime provider contract accepts `openai-compatible`, `azure-openai`, `anthropic`, `perplexity`, and `minimax`. Google/Gemini is not wired as a runtime provider in V1; do not document or configure `google` as a provider account type.

Provider key API examples are in `docs/local-run.md`.

## Rate Limiting

API rate limits are Redis-backed and use `REDIS_URL`. Auth endpoints use `RATE_LIMIT_AUTH_PER_MINUTE` with a fixed one-minute window. Chat, agent-run, and expensive provider endpoints use `RATE_LIMIT_CHAT_PER_MINUTE` with a sliding one-minute window. File uploads use `RATE_LIMIT_FILE_UPLOAD_PER_MINUTE` with a sliding one-minute window.

Requests over the limit return `429` with `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers plus JSON retry details. Authenticated requests are keyed by user id; anonymous requests fall back to client IP from forwarded headers.

## Background Jobs and Retention

The `worker` service consumes four queues on `REDIS_URL`. `file-ingestion` and `provider-sync` are producer-driven, `cleanup` is scheduled by the worker itself, and `agent-run` is deliberately inert.

A `sync-provider` job is enqueued when an admin creates a provider account and when an admin runs a model sync from `/admin/providers`. A queue error there is logged as a warning and does not fail the request. The worker only syncs accounts whose status is `enabled`, and it never disables a binding on its own — retiring a model that a provider stopped reporting stays an explicit admin action.

Retention cleanup runs daily at 03:15 in the worker container's timezone, which is UTC in the shipped image unless you set `TZ`. Each run sweeps all three targets:

| Target | Table | Default window |
| --- | --- | --- |
| `job-failures` | `job_failures` | 30 days |
| `completed-runs` | `agent_runs`, terminal statuses only | 90 days |
| `orphan-attachments` | `attachments` with no owning conversation, message, or knowledge document | 7 days |

The windows are compiled into the worker; changing them is a code change and a redeploy. A one-off job may pass `olderThanDays` to override the window for the targets it selects. The worker re-registers the schedule under a fixed key on every boot, so restarts and multiple replicas do not stack duplicate schedules.

Jobs on all three working queues retry 3 times with exponential backoff, then land in `job_failures` and appear in the job-failure rollup on `/admin/operations`.

Two limitations matter operationally: deleting an orphan attachment row does not remove the underlying object from MinIO, and the first scheduled run after this change deploys will delete whatever backlog the deployment has already accumulated. Back up Postgres before that worker restart.

For the manual trigger, log lines to check, and the full limitation list, see `docs/runbooks/worker-queues.md`.

## Smoke Testing

Run `npm run smoke` and the checklist in `docs/smoke-test.md` after first deploy, upgrades, restore drills, and operator changes. Set `PACKETCHAT_BASE_URL` for non-local targets and `PACKETCHAT_SMOKE_EMAIL` / `PACKETCHAT_SMOKE_PASSWORD` when login should be included.

## UI Routes

- `/login`: local password login.
- `/chat`: authenticated chat test surface.
- `/providers`: provider account management.
- `/projects`: user-owned project workspaces and persistent instructions.
- `/prompts`: prompt management.
- `/knowledge`: knowledge base, document management, retrieval test search, and per-result debug metadata.
- `/agents`: single-pass augmented agent drafts, publishing, sharing, manual/chat-launched runs, and run history.
- `/approvals`: user approval queue for pending agent action checkpoints.
- `/admin/users`: admin user operations.
- `/admin/usage`: usage governance, run-rate projection, and estimated-cost review.
- `/admin/audit`: latest audit events and action summaries.
- `/admin/operations`: provider/model/knowledge/run/job health rollups.
- `/admin/approvals`: admin view of pending approval steps.

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
- Back up Postgres and MinIO before upgrades, and specifically before the first worker restart that carries scheduled retention cleanup.
- Run a restore drill before calling the deployment production-ready.
- Run the migration job exactly once per release before app rollout.
- Run `npm run smoke` after first deploy, upgrades, and restore drills. Include `PACKETCHAT_SMOKE_EMAIL` / `PACKETCHAT_SMOKE_PASSWORD` for authenticated coverage.
- Confirm the worker logged `Cleanup schedule registered` after rollout; without it there is no retention schedule until the next boot.
- Review the release-readiness surfaces in `docs/release-readiness.md` before pilot/prod handoff.
- Stop the Compose stack with `npm run compose:down`; do not remove volumes unless intentionally wiping local data.

Outside the V1 promise: multi-tenant workspaces/teams, SSO, high availability orchestration, external managed-service recipes, Kubernetes manifests, email-delivered invite/reset flows, scheduled agent runs, evaluations, true multi-step tool loops, and Google/Gemini runtime provider support.
