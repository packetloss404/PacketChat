# Worker Queues Runbook

The `worker` service consumes four BullMQ queues backed by `REDIS_URL`.

| Queue | Job name | Producer | Behavior |
| --- | --- | --- | --- |
| `file-ingestion` | `ingest-file` | knowledge document upload | Downloads the object, extracts text, chunks it, and writes `knowledge_chunks`. |
| `provider-sync` | `sync-provider` | `POST /api/providers` (account created) and `POST /api/providers/{providerId}/models` (admin model sync) | Lists models from the provider and upserts `model_catalog` and `model_account_bindings`. |
| `cleanup` | `run-cleanup` | the worker's own daily scheduler | Deletes rows past their retention window. |
| `agent-run` | `run-agent` | `POST /api/agents/{agentId}/runs` with `{"async": true}` (or `Prefer: respond-async`) | Rebuilds the run from its row, claims it, and executes it through `@packetchat/agent-runtime`. |

Every handler validates the job name and rejects anything it does not recognize.

## Agent Runs

A `run-agent` job carries only `runId`, `agentId` and `resourceOwnerUserId`. Everything else is read back from `agent_runs` and the agent version the run pinned, so a job cannot drift from what the caller was told. `resourceOwnerUserId` is the **agent's** owner, which is who knowledge bases and child agents resolve against; the caller who started the run is `agent_runs.owner_user_id`, and for a shared agent those are different people. The worker refuses a job whose owner disagrees with the agent row.

The provider account and model are read from `agent_runs.resolved_provider_account_id` / `resolved_model`, written when the run was created. The worker never re-resolves them: the default provider account can change between enqueue and execution, and a run must not quietly execute against a different model than the caller asked for. A run without a resolved binding is failed, not guessed at.

Execution is claimed with a single conditional update from `queued`/`preparing` to `running`, so a BullMQ retry, a redelivered stalled job, or the web fallback below cannot run the same run twice. A job that loses the claim completes quietly and logs the status it found; a run that already failed is not re-executed by a retry, because re-running it would repeat paid provider calls. Everything else that stops a run executing throws, so it lands in `job_failures` and is retried.

Runs are capped at 15 minutes. A worker that dies mid-run leaves the run in `running`, which `GET /api/agents/{agentId}/runs/{runId}` reconciles to `timed_out` once it is older than 20 minutes.

If the enqueue fails - Redis down, or the five-second enqueue timeout - `web` executes the run in its own process instead of failing the caller. That path takes the same claim first, because a timed-out enqueue can still have landed the job. The fallback run is not durable: it dies with the `web` process, and the caller is not told which path their run took.

Jobs retry 3 times with exponential backoff starting at 5 seconds, and every failed attempt is recorded in `job_failures`. A retry does not re-execute a run that already reached a terminal status - the claim refuses it - so a run that failed inside the executor is failed once and the remaining attempts complete quietly.

Log lines to follow one run through the worker:

- `Agent run job received` - the job was dequeued, with its `runId`.
- `Agent run job completed` - the run executed, with the status it reached (`completed` or `waiting_input`).
- `Agent run job skipped; the run is already claimed` - the run was not claimable. The logged `status` says why: `running` means another executor holds it, and `failed` / `timed_out` / `cancelled` mean it will never execute now.
- `Agent run enqueue failed; running in process instead` - logged by `web` at warn level. Every one of these is a run the queue never saw.

A run's own history is in `GET /api/agents/{agentId}/runs/{runId}` (status, steps, events, usage), and the seven-day rollup on `/admin/operations` shows failed and timed-out runs alongside job failures.

## Provider Sync

A `sync-provider` job is enqueued after an admin creates a provider account, and after an admin runs a model sync from `/admin/providers`. Both producers are wrapped so a queue error is logged as a warning and does not fail the request; the account is still created and the manual refresh still succeeds.

The worker refuses accounts whose `status` is not `enabled`, so the model-sync route skips the enqueue for disabled accounts rather than queueing a job that can only fail.

Sync writes are conservative on purpose:

- `enabled` and `capability_overrides` on an existing binding are never touched, so operator choices survive a resync.
- Bindings for models the provider stopped reporting are counted but left alone. One listing call cannot distinguish a retired model from a degraded provider response. Retiring a model stays an explicit admin action through the model sync in `/admin/providers`, which does disable what is missing.
- A provider without a model-listing endpoint is a supported configuration, not a failure: the job logs `Provider model discovery unsupported` and writes nothing.

Failures rethrow, so the job is retried and then recorded in `job_failures`.

## Retention Policy

| Target | Table | What is deleted | Default window |
| --- | --- | --- | --- |
| `job-failures` | `job_failures` | every row older than the cutoff | 30 days |
| `completed-runs` | `agent_runs` | runs whose `status` is `completed`, `failed`, `cancelled`, or `timed_out`, and whose `created_at` and `coalesce(ended_at, created_at)` are both past the cutoff | 90 days |
| `orphan-attachments` | `attachments` | rows with no `conversation_id`, no `message_id`, no `knowledge_documents` row pointing at them, and a status other than `processing` | 7 days |

The windows live in `DEFAULT_RETENTION` in `apps/worker/src/cleanup.ts`. They are not environment variables; changing them is a code change and a redeploy. A one-off job can override the window for the targets it selects with `olderThanDays`.

The `completed-runs` status filter is re-applied inside the delete, so a stale id list can never remove a live run. The `orphan-attachments` predicate is re-applied too, so an attachment adopted between the list and the delete survives.

Each pass claims at most 5000 rows per target and deletes them in batches of 500. A large backlog therefore drains over several runs instead of one long-locking statement.

## The Daily Schedule

Cleanup runs at `15 3 * * *` — 03:15 daily in the worker container's timezone, which is UTC in the shipped image unless you set `TZ` — with target `all`.

The worker registers the schedule on every boot with `Queue.upsertJobScheduler` under the key `daily-cleanup`. Because the key is fixed, restarts and multiple worker replicas do not stack duplicate schedules, and a changed pattern takes effect at the next worker boot.

Registration failure does not stop the worker: file ingestion and provider sync still run. Look for these lines:

- `Cleanup schedule registered` — boot succeeded.
- `Cleanup schedule registration failed` — logged at error level. There is no schedule until the next boot retries the upsert; trigger cleanup by hand in the meantime.
- `Cleanup job completed` — one pass finished, with the selected `targets`, the per-target `deleted` counts, and the `cutoffs` used.

## Trigger A Cleanup By Hand

There is no admin UI and no npm script for this yet. Enqueue the job from the running worker container:

```shell
docker compose --env-file .env -f infrastructure/compose/docker-compose.yml exec worker \
  node --input-type=module -e "import { enqueueCleanupJob } from '@packetchat/jobs'; await enqueueCleanupJob({ target: 'all' }); process.exit(0);"
```

`process.exit(0)` is required; the Redis connection stays open otherwise.

To sweep one target, or to use a window other than the default:

```shell
docker compose --env-file .env -f infrastructure/compose/docker-compose.yml exec worker \
  node --input-type=module -e "import { enqueueCleanupJob } from '@packetchat/jobs'; await enqueueCleanupJob({ target: 'job-failures', olderThanDays: 90 }); process.exit(0);"
```

Rules the job enforces before deleting anything:

- `target` must be `job-failures`, `completed-runs`, `orphan-attachments`, or `all`. Anything else fails the job rather than quietly cleaning nothing.
- `olderThanDays` must be a whole number of at least 1. Zero, negative, and fractional values fail before the first query, because a cutoff at or after now would sweep live rows.
- `olderThanDays` overrides the window of every target the job selected, and only those.

## When A Job Fails

All four queues retry 3 times with exponential backoff starting at 5 seconds. Each failed attempt — not only the last — is written to `job_failures` with the queue name, job name, error message, and payload, and appears in the job-failure rollup on `/admin/operations`. The payload carries `attemptsMade`, which is how a retried job is told apart from one that failed once.

Cleanup deletes are idempotent, so a retry after a partial pass is safe: an already-deleted id matches nothing.

## First Run After Upgrading

No deployment has run cleanup before. The first 03:15 pass after this change deploys will find every `job_failures` row older than 30 days and every terminal `agent_runs` row older than 90 days that the deployment has accumulated.

Back up Postgres before the worker restart that carries this change — `npm run backup:postgres`, or the manual commands in `docs/runbooks/backup-restore.md`. The per-target 5000-row cap means the backlog drains over several runs rather than in one.

## Known Limitations

- Orphan attachment cleanup deletes the MinIO object before the row. The row carries the only copy of `bucket`/`object_key`, so removing it first would strand the object unidentifiably. If the object delete fails the row is kept and logged at warn level, and the next run retries it — expect `Cleanup left an attachment row in place` in the worker log when object storage is unavailable.
- `model_account_bindings` has no unique constraint on `(provider_account_id, model_catalog_id)`. Two provider-sync jobs for the same account that overlap — creating an account and immediately running a model sync, for example — can both read an empty binding set and both insert. If `/providers` lists a model twice for one account, delete the extra binding.
- The queue's Redis connection retries forever and buffers commands while offline, so an enqueue against an unreachable Redis never settles on its own. Every producer is bounded at five seconds (`ENQUEUE_TIMEOUT_MS`) so the request fails fast instead, but each one then degrades differently: provider sync logs a warning and the account is still created, a file upload marks the document and attachment `failed` at the enqueue step, and an async agent run executes inside `web` instead. After a Redis outage, expect knowledge documents that need re-uploading and agent runs that were never durable.
- The model-sync route refreshes models synchronously and also enqueues a background sync, so a manual refresh makes two model-listing calls to the provider a few seconds apart. The background job cannot undo the route's work, but it does double the outbound calls on a rate-limited provider.
- A queued run is aged from `created_at` by the 20-minute reconcile in the single-run GET, so time spent waiting in the queue counts against the same window as time spent executing. If the worker is down or backlogged for longer than that, the caller polling the run they were told to poll flips it to `timed_out` with `error_code` `run_abandoned`; the worker then cannot claim it, logs `Agent run job skipped`, and completes the job, so nothing retries it and the conversation is left with the question and no answer. Watch `agent-run` queue depth, and re-run anything that timed out without ever starting - `started_at` is null on those rows.
- Cancelling a run and resuming a `waiting_input` run still work only inside the process that owns the run, so neither reaches a run the worker is executing. The reconcile deliberately spares `waiting_input`, so such a run waits indefinitely rather than being failed.
- A published agent spec whose `providerAccountId` is not a UUID now fails run creation with an unhandled `500` and no run row, because the value is written to `agent_runs.resolved_provider_account_id`, a `uuid` column, while the draft writer only checks that it is a string. Fix the agent's provider account in the builder and republish.
- Runs created before migration `0006` have no resolved provider binding. If one is ever enqueued the job fails with `has no resolved provider binding to execute` rather than re-resolving against whatever the default account is today.
